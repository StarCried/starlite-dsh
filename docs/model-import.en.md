# Model import

[简体中文](model-import.md) · English · [User guide](user-guide.en.md)

Release 0.1.0 includes English controls, three optional bundled gestures and the separately licensed BlueFish example.

## Add a model

Click **Add VRM model** and select a `.vrm` file. After validation, StarLite adds and selects it automatically. Existing models and preferences remain available. No archive extraction or separate Save button is needed.

**Remove** deletes the library entry, its mappings, and the managed import copy after confirmation. The original VRM is kept. Removing the active model hides it, and restarting does not restore it automatically. An available example can be selected again to download it; updating a custom model means importing the new file, checking it, then removing the old entry.

Example models have separate licenses, readable through **View license** before download. Weiguang is the initial default. BlueFish appears only when a verified download is configured. Restart DSH after selecting an uncached example; other examples are not downloaded together.

Supported formats are **VRM 0 and VRM 1**. Model, texture, and animation data must be embedded in the file. External buffers and texture references are rejected. Convert Blender projects, FBX files, and Unity `.anim` clips in an authoring tool first.

# Humanoid bones

Bones are recognized by the VRM **Humanoid mapping**, not by Blender object or bone names. Map these 15 required fields before exporting:

```text
hips, spine, head
leftUpperArm, leftLowerArm, leftHand
rightUpperArm, rightLowerArm, rightHand
leftUpperLeg, leftLowerLeg, leftFoot
rightUpperLeg, rightLowerLeg, rightFoot
```

Shoulders, chest, neck, toes, eyes, and fingers are optional. Missing finger mappings cannot provide finger animation automatically.

# Tail sway

Open **Pose and tracking → Tail sway** and enter the exact, unique root node name from the VRM. A blank name disables it. Angle is the maximum to either side (0–50°, default 10°); period is seconds per complete left/right cycle (3–30, default 10). Values are saved per model. Authors can seed new imports using `extras.starlite.adjustments.tailSway`, for example `{"rootBone":"Tail","amplitudeDegrees":35,"periodSeconds":10}`.

Any standard humanoid VRM 0/1 with tail bones can opt in. Model up determines the rotation axis. Sway runs only in the baseline Idle loop, fades during foreground actions, and resumes afterward. Pausing/hiding stops updates; authored motion and breathing durations are unchanged. Springs, gravity, colliders and simulation roots remain entirely model-owned. Missing or duplicate root names cannot be saved.

# Blinking and cursor tracking

Blinking is optional. Models without blink expressions still support idle, breathing, and head tracking. To enable blinking, register either:

- **VRM 0:** `presetName: "blink"`, or both `blink_l` and `blink_r`.
- **VRM 1:** `expressions.preset.blink`, or both `blinkLeft` and `blinkRight`.

Expressions must bind actual closed-eye morph targets with nonzero weights. Shape key names are unrestricted. Empty expressions, zero weights, or a single unilateral blink do not enable automatic blinking. Declared invalid mesh or morph references still cause import to fail.

Head tracking has angle limits. Independent **eye tracking is optional** and requires valid VRM `lookAt` configuration using eye bones or expressions, including supported horizontal and vertical ranges.

# Idle and event motions

Models without animation can be imported. The bundled `StarLiteIdle` supplies a relaxed pose and gentle breathing. An embedded `Idle`, a profile's `neutralAnimation`, or explicit default mappings can select a model-authored base pose instead.

Humanoid retargeting depends on body proportions and skin weights. The default idle's final pose and bake were made by StarCried and include the Warudo `Human@SM Breathe` breathing layer. Bundled gestures are also available for optional event mapping; they do not require model-specific marks or facial meshes.

Embedded standard glTF animations are listed automatically. Use unique English names; names are case-sensitive. The reserved names are `StarLiteIdle`, `StarLiteCuriousPeek` (2.1 seconds), `StarLiteHappyWave` (4.6 seconds), and `StarLiteSleepyStartle` (5.5 seconds). Existing mappings are retained. New generic models start with empty click/ambient mappings; select the gestures you want.

- **Idle:** loops continuously.
- **Working (including thinking), Completed, Error, Blocked, Awaiting confirmation:** optional, play once then return to idle; a newer state may interrupt.
- **Click response and Ambient gestures:** select multiple motions to choose randomly each time. Unselected actions do not trigger. These gestures do not trigger while DSH is busy.

Mappings save automatically. **Pose and tracking** adjusts the bundled idle's arms, palms, wrists, fingers, elbows, and independent head/eye tracking. Pose changes do not alter authored motions or the source file. Each model keeps its own adjustments; each setting can be reset.

Model authors can provide initial settings in `extras.starlite.adjustments`, for example `{"idle":{"wristLiftDegrees":30},"gaze":{"headStrength":2}}`. These values seed the new import once. Saved user settings remain authoritative across restarts, model switches, and plugin updates. Clearing adjustments restores program baseline values without reapplying the embedded defaults. Pose values affect only `StarLiteIdle`, so select it in the model's default idle mapping; gaze-only settings do not require changing the idle motion. The field types and ranges match **Pose and tracking**. Unknown fields or invalid values cause import to fail.

# License and local files

Import creates a local copy without uploading or modifying the source. A failed import leaves the active model unchanged.

Author and license information comes from VRM metadata and is available through **View license**. Confirm rights to the model, textures, and motions. Missing license information does not grant permission. Original third-party license text is preserved in its original language.
