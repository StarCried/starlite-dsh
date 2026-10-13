import { crc32, deflateRawSync } from "node:zlib";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINARY = "dsh-inochi2d-pet.exe";
const PRODUCT = "StarLite for DSH";

export function assertPortableExecutable(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw Error("portable executable is not a PE file");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 94 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550
    || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 20) < 70
    || pe + 24 + bytes.readUInt16LE(pe + 20) > bytes.length
    || bytes.readUInt16LE(pe + 24) !== 0x20b) throw Error("portable executable must be Windows x64 PE32+");
  if (bytes.readUInt16LE(pe + 24 + 68) !== 2) throw Error("portable executable must use the Windows GUI subsystem");
}

/** Package only the self-contained executable and its notices, never a model. */
export async function packPortable(rootDirectory) {
  const root = await realpath(rootDirectory);
  const config = JSON.parse(await ordinaryFile(root, "apps/desktop/src-tauri/tauri.conf.json"));
  const workspace = JSON.parse(await ordinaryFile(root, "package.json"));
  if (config.productName !== PRODUCT || config.version !== workspace.version
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(config.version)) {
    throw Error("portable product identity and version must match the workspace");
  }
  const executable = await ordinaryFile(root, `apps/desktop/src-tauri/target/release/${BINARY}`);
  assertPortableExecutable(executable);
  const entries = [
    [BINARY, executable],
    ["LICENSE", await ordinaryFile(root, "LICENSE")],
    ["THIRD_PARTY_LICENSES.txt", await ordinaryFile(root, "release-output/THIRD_PARTY_LICENSES.txt")],
    ["README.txt", Buffer.from(portableInstructions(config.version))],
  ];
  const outputDirectory = join(root, "release-output");
  await mkdir(outputDirectory, {recursive: true});
  const output = join(outputDirectory, `StarLite-for-DSH_${config.version}_x64-portable.zip`);
  // Existing outputs are reviewable artifacts: never silently replace them.
  await writeFile(output, zip(entries), {flag: "wx"});
  return output;
}

async function ordinaryFile(root, relativePath) {
  const segments = relativePath.split("/");
  let path = root;
  for (let index = 0; index < segments.length; ++index) {
    path = join(path, segments[index]);
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw Error(`portable input is missing or unsafe: ${relativePath}`);
    }
    if (index === segments.length - 1 && (info.size === 0 || info.size > 64 * 1024 * 1024)) {
      throw Error(`portable input has an invalid size: ${relativePath}`);
    }
  }
  return readFile(path);
}

function portableInstructions(version) {
  return `StarLite for DSH ${version} · Windows 11 x64 免安装版

需要 Windows WebView2，以及 WSL2 中已经可用的 DSH。
本程序未签名。请核对作者提供的 SHA256SUMS，不要关闭系统防护。

1. 将本目录解压到固定位置，例如 D:\\Apps\\StarLite，不要修改 EXE 文件名。
2. 双击 ${BINARY}，在设置中导入独立授权的微光 ZIP 并确认许可。
3. 在 WSL 给日常 profile 安装同版本桥接插件：
   dsh plugin --profile web add /path/to/dsh-starlite-${version}.tgz
4. 在启动 DSH 的 WSL 终端设置 Windows EXE 的绝对路径，然后启动：
   export DSH_INOCHI2D_PET_EXE='D:\\Apps\\StarLite\\${BINARY}'
   dsh --profile web

将路径和 web 换成自己的目录及 profile。日常可将 export 一行加入自己的 shell 配置，
或和 dsh 命令一起保存为启动脚本。移动 EXE 后请同步修改路径。
免安装版不会注册启动协议；显式路径优先于已有安装器的注册。

桌宠仅在 DSH 连接后出现；未启动 DSH 时可从托盘打开设置。
设置、模型与窗口偏好仍保存在 Windows AppData，未保存在本目录。
升级前退出桌宠，解压新版本到程序目录；用户数据保留。
卸载桥接使用 dsh plugin --profile web remove dsh-starlite，退出桌宠后可删除本目录。
删除程序目录不会删除 AppData 中的用户模型与设置。

程序采用 BSD-2-Clause，见 LICENSE；依赖许可见 THIRD_PARTY_LICENSES.txt。
程序不包含微光或第三方动作；资源包单独授权。
`;
}

// Four fixed, flat names: ZIP32 with UTF-8 names and raw DEFLATE needs no dependency.
function zip(entries) {
  const files = [], directory = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name), compressed = deflateRawSync(bytes), checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    local.copy(central, 8, 6, 28); central.writeUInt32LE(offset, 42);
    files.push(local, filename, compressed); directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralDirectory, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== "--")) throw Error("pack:portable does not accept arbitrary input paths");
  console.log(await packPortable(resolve(dirname(fileURLToPath(import.meta.url)), "..")));
}
