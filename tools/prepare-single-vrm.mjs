// Development asset preparation. The application imports the resulting VRM.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const align4 = (size) => (size + 3) & ~3;

export function readGlb(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw Error("Invalid GLB header");
  }
  let json;
  let bin;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw Error("Truncated GLB chunk");
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (length % 4 || end > bytes.length) throw Error("Invalid GLB chunk length");
    if (type === JSON_CHUNK) {
      if (json || offset !== 12 || length > 16 * 1024 * 1024) throw Error("Invalid GLB JSON chunk");
      json = JSON.parse(bytes.subarray(offset + 8, end).toString("utf8").trimEnd());
    } else if (type === BIN_CHUNK) {
      if (bin) throw Error("Duplicate GLB binary chunk");
      bin = bytes.subarray(offset + 8, end);
    } else throw Error("Unsupported GLB chunk");
    offset = end;
  }
  if (!json || !bin || json.asset?.version !== "2.0" ||
      json.buffers?.length !== 1 || json.buffers[0].uri !== undefined ||
      !Number.isInteger(json.buffers[0].byteLength) || json.buffers[0].byteLength < 0 ||
      json.buffers[0].byteLength > bin.length ||
      (json.images ?? []).some((image) => image.uri !== undefined)) {
    throw Error("Expected a self-contained binary glTF");
  }
  return { json, bin: bin.subarray(0, json.buffers[0].byteLength) };
}

export function glbWriter(json, initialBin) {
  const parts = [initialBin, Buffer.alloc(align4(initialBin.length) - initialBin.length)];
  let length = align4(initialBin.length);
  json.bufferViews ??= [];
  json.accessors ??= [];
  return {
    floats(values, size, bounds = false) {
      if (values.length === 0 || values.length % size || !values.every(Number.isFinite)) {
        throw Error("Invalid animation values");
      }
      const data = Buffer.alloc(values.length * 4);
      values.forEach((value, index) => data.writeFloatLE(value, index * 4));
      const view = json.bufferViews.length;
      json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length });
      parts.push(data);
      length += data.length;
      const accessor = { bufferView: view, componentType: 5126, count: values.length / size,
        type: size === 1 ? "SCALAR" : "VEC" + size };
      if (bounds) {
        accessor.min = Array.from({ length: size }, (_, axis) =>
          Math.min(...values.filter((_, index) => index % size === axis)));
        accessor.max = Array.from({ length: size }, (_, axis) =>
          Math.max(...values.filter((_, index) => index % size === axis)));
      }
      json.accessors.push(accessor);
      return json.accessors.length - 1;
    },
    finish() {
      json.buffers = [{ byteLength: length }];
      const jsonBytes = Buffer.from(JSON.stringify(json));
      const paddedJson = Buffer.alloc(align4(jsonBytes.length), 0x20);
      jsonBytes.copy(paddedJson);
      const bin = Buffer.concat(parts);
      const header = Buffer.alloc(20);
      header.writeUInt32LE(0x46546c67, 0);
      header.writeUInt32LE(2, 4);
      header.writeUInt32LE(28 + paddedJson.length + bin.length, 8);
      header.writeUInt32LE(paddedJson.length, 12);
      header.writeUInt32LE(JSON_CHUNK, 16);
      const binaryHeader = Buffer.alloc(8);
      binaryHeader.writeUInt32LE(bin.length, 0);
      binaryHeader.writeUInt32LE(BIN_CHUNK, 4);
      return Buffer.concat([header, paddedJson, binaryHeader, bin]);
    },
  };
}

function addSampler(writer, animation, timeAccessor, values, size) {
  animation.samplers.push({
    input: timeAccessor, output: writer.floats(values, size), interpolation: "LINEAR",
  });
  return animation.samplers.length - 1;
}

const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export function hasAuthoredEyeRotation(track) {
  return Boolean(track?.values.some((value, index) =>
    Math.abs(Math.abs(value) - (index % 4 === 3 ? 1 : 0)) > 1e-6));
}

export async function prepareSingleVrm({ runtime, model, motions, profile, license, mappings, output }) {
  if (resolve(model) === resolve(output)) throw Error("The source VRM must remain unchanged");
  const moduleAt = (path) => import(pathToFileURL(resolve(runtime, "node_modules", path)));
  const THREE = await moduleAt("three/build/three.module.js");
  const { GLTFLoader } = await moduleAt("three/examples/jsm/loaders/GLTFLoader.js");
  const { VRMLoaderPlugin } = await moduleAt("@pixiv/three-vrm/lib/three-vrm.module.js");
  const { VRMAnimationLoaderPlugin, createVRMAnimationClip } =
    await moduleAt("@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js");
  const modelBytes = await readFile(model);
  const { json, bin } = readGlb(modelBytes);
  if (json.animations?.length) throw Error("The source VRM already contains animations");
  const loader = new GLTFLoader();
  loader.register((parser) => {
    // No rendering or texture decoding is needed when sampling the skeleton.
    parser.loadTexture = async () => {
      const texture = new THREE.Texture();
      texture.image = { width: 1, height: 1 };
      return texture;
    };
    return new VRMLoaderPlugin(parser);
  });
  const gltf = await loader.parseAsync(arrayBuffer(modelBytes), "");
  const vrm = gltf.userData.vrm;
  if (!vrm?.humanoid) throw Error("The model must be a humanoid VRM");
  const nodes = await Promise.all(json.nodes.map((_, index) => gltf.parser.getDependency("node", index)));
  const indexes = new Map(nodes.map((node, index) => [node, index]));
  const humanoid = Object.entries(vrm.humanoid.rawHumanBones).map(([bone, value]) => ({
    bone, node: value.node, index: indexes.get(value.node),
  })).filter(({ index }) => index !== undefined);
  if (!humanoid.some(({ bone }) => bone === "hips")) throw Error("The humanoid has no hips");
  const meshes = [];
  nodes.forEach((node, index) => {
    if (json.nodes[index].mesh === undefined) return;
    let mesh;
    node.traverse((child) => { if (!mesh && child.isMesh && child.morphTargetInfluences?.length) mesh = child; });
    if (mesh) meshes.push({ index, mesh });
  });
  const snapshots = [];
  vrm.scene.traverse((node) => snapshots.push({
    node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(),
  }));
  const restore = () => {
    for (const state of snapshots) {
      state.node.position.copy(state.position);
      state.node.quaternion.copy(state.quaternion);
      state.node.scale.copy(state.scale);
    }
    vrm.expressionManager?.resetValues();
    vrm.scene.updateMatrixWorld(true);
  };
  const animationLoader = new GLTFLoader();
  animationLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const files = (await readdir(motions)).filter((file) => extname(file).toLowerCase() === ".vrma").sort();
  if (!files.length || files.length > 100) throw Error("Expected 1 to 100 VRMA motions");
  const writer = glbWriter(json, bin);
  json.animations = [];
  for (const file of files) {
    restore();
    const motionBytes = await readFile(resolve(motions, file));
    readGlb(motionBytes);
    const motionGltf = await animationLoader.parseAsync(arrayBuffer(motionBytes), "");
    const source = motionGltf.userData.vrmAnimations?.[0];
    if (!source) throw Error("No VRM animation in " + file);
    const clip = createVRMAnimationClip(source, vrm);
    const name = basename(file, extname(file));
    const animatedBones = humanoid.filter(({ bone }) =>
      !["leftEye", "rightEye"].includes(bone) ||
      hasAuthoredEyeRotation(source.humanoidTracks.rotation.get(bone)) ||
      hasAuthoredEyeRotation(source.lookAtTrack));
    const times = [...new Set(clip.tracks.flatMap((track) => Array.from(track.times)))].sort((a, b) => a - b);
    if (times.length < 2 || times.length > 36000 || !times.every(Number.isFinite) || times[0] < 0) {
      throw Error("Invalid animation times: " + name);
    }
    const expressions = [...source.expressionTracks.preset.keys(), ...source.expressionTracks.custom.keys()]
      .filter((expression) => vrm.expressionManager?.getExpression(expression));
    const rotations = new Map(animatedBones.map(({ bone }) => [bone, []]));
    const hipsTranslations = [];
    const expressionValues = new Map(expressions.map((expression) => [expression, []]));
    const morphWeights = new Map(meshes.map(({ index }) => [index, []]));
    const mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play().clampWhenFinished = true;
    for (const time of times) {
      mixer.setTime(time);
      vrm.humanoid.update();
      if (source.lookAtTrack) vrm.lookAt?.update(0);
      vrm.expressionManager?.update();
      vrm.scene.updateMatrixWorld(true);
      for (const { bone, node } of animatedBones) {
        const values = rotations.get(bone);
        let quaternion = node.quaternion.toArray();
        const offset = values.length - 4;
        if (offset >= 0 && quaternion.reduce((sum, value, axis) => sum + value * values[offset + axis], 0) < 0) {
          quaternion = quaternion.map((value) => -value);
        }
        values.push(...quaternion);
        if (bone === "hips") hipsTranslations.push(...node.position.toArray());
      }
      for (const expression of expressions) expressionValues.get(expression).push(vrm.expressionManager.getValue(expression));
      for (const { index, mesh } of meshes) morphWeights.get(index).push(...mesh.morphTargetInfluences);
    }
    const animation = { name, channels: [], samplers: [] };
    const input = writer.floats(times, 1, true);
    for (const { bone, index } of animatedBones) {
      const sampler = addSampler(writer, animation, input, rotations.get(bone), 4);
      animation.channels.push({ sampler, target: { node: index, path: "rotation" } });
      if (bone === "hips") {
        const sampler = addSampler(writer, animation, input, hipsTranslations, 3);
        animation.channels.push({ sampler, target: { node: index, path: "translation" } });
      }
    }
    if (expressions.length) {
      for (const { index } of meshes) {
        const sampler = addSampler(writer, animation, input, morphWeights.get(index), 1);
        animation.channels.push({ sampler, target: { node: index, path: "weights" } });
      }
      const expressionSamplers = Object.fromEntries(expressions.map((expression) => [
        expression, addSampler(writer, animation, input, expressionValues.get(expression), 1),
      ]));
      // Ordinary viewers use weights channels. Named expression scalars allow
      // StarLite to combine those expressions with automatic blink and look-at.
      animation.extras = { starlite: { expressions: expressionSamplers } };
    }
    json.animations.push(animation);
    mixer.stopAllAction();
    mixer.uncacheRoot(vrm.scene);
    console.log(name + ": " + times.length + " samples, " + animation.channels.length + " channels");
  }
  json.extras = { ...json.extras, starlite: {
    profile: JSON.parse(await readFile(profile, "utf8")),
    license: { title: "微光 v3.0", text: await readFile(license, "utf8") },
    mappings: JSON.parse(await readFile(mappings, "utf8")),
  } };
  const bytes = writer.finish();
  await writeFile(output, bytes, { flag: "wx" });
  return { bytes: bytes.length, animations: json.animations.map(({ name }) => name) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [runtime, model, motions, profile, license, mappings, output] = process.argv.slice(2);
  if (!output) throw Error("Usage: prepare-single-vrm <runtime-checkout> <model.vrm> <motions-dir> <profile.json> <license.md> <mappings.json> <output.vrm>");
  console.log(JSON.stringify(await prepareSingleVrm({ runtime, model, motions, profile, license, mappings, output })));
}
