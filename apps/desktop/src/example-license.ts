import weiguang from "../../../docs/weiguang-license.md?raw";
import weiguangEnglish from "../../../docs/weiguang-license.en.md?raw";
import bluefish from "../../../docs/bluefish-license.md?raw";
import bluefishEnglish from "../../../docs/bluefish-license.en.md?raw";
import { uiLocale } from "./i18n.js";

/** Only translate the exact bundled terms. Arbitrary model metadata stays verbatim. */
export function exampleLicenseText(id: string, text: string): string {
  if (uiLocale() !== "en") return text;
  const pair = id === "weiguang-default" ? [weiguang, weiguangEnglish]
    : id === "bluefish-default" ? [bluefish, bluefishEnglish] : undefined;
  const normalize = (value: string) => value.replace(/\r\n/gu, "\n").trim();
  return pair && normalize(text) === normalize(pair[0]!) ? pair[1]! : text;
}
