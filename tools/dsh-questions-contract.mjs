/** Validate the public Host seams before advertising timed or continued input. */
export function questionLifecycleContract(sources) {
  const timed = /\bwait\?\s*:\s*\{/u.test(sources.questions ?? "") || /\baskTimed\s*\(/u.test(sources.service ?? "");
  if (!timed) return {kind:"blocking",missing:[]};
  const requirements = [
    ["question wait identity and timed marker", sources.questions, /wait\?:\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?callId:\s*ToolCallId;\s*(?:\/\*[\s\S]*?\*\/\s*)?timed\?:\s*boolean;/u],
    ["foreground claim and Host remaining duration", sources.service, /attachWait\(agent:\s*Agent,\s*callId:\s*ToolCallId,\s*signal:\s*AbortSignal\):\s*AsyncIterable<\{\s*remainingMs:\s*number;\s*\}>;/u],
    ["atomic continued answer", sources.service, /answer\(agent:\s*Agent,\s*callId:\s*ToolCallId,\s*answer:\s*AskUserQuestionAnswer\):\s*boolean;/u],
    ["question business error taxonomy", sources.service, /class\s+UserQuestionError\s+extends\s+HarnessError\s*\{\s*constructor\(message:\s*string,\s*code:\s*string,/u],
    ["continued question states", sources.questions, /type\s+UserQuestionState\s*=\s*'open'\s*\|\s*'continued';/u],
    ["continued question identity", sources.questions, /interface\s+PendingUserQuestion\s*\{\s*readonly\s+callId:\s*ToolCallId;\s*readonly\s+questions:\s*readonly\s+AskUserQuestionItem\[\];\s*readonly\s+state:\s*UserQuestionState;/u],
    ["active question view", sources.questions, /readonly\s+active:\s*readonly\s+PendingUserQuestion\[\];/u],
    ["Host question fold shape", sources.fold, /interface\s+UserQuestionFold\s*\{\s*readonly\s+timed:\s*boolean;\s*readonly\s+questions:\s*UserQuestionProjectionView;/u],
    ["Host question projection registration", sources.fold, /interface\s+SessionProjectionStateMap\s*\{\s*userQuestions:\s*UserQuestionProjectionState;/u],
    ["projection change subscription and disposal", sources.projections, /onChanged\(listener:\s*ProjectionChangeListener\):\s*\(\)\s*=>\s*void;/u],
    ["authoritative Host projection read", sources.projections, /stateOf<K\s+extends\s+keyof\s+SessionProjectionStateMap>\(session:\s*Session,\s*key:\s*K\):\s*SessionProjectionStateMap\[K\]\s*\|\s*undefined;/u],
    ["exact live agent lookup", sources.agents, /get\(id:\s*SessionId\):\s*Agent\s*\|\s*undefined;/u],
    ["live runtime root directory", sources.agents, /roots\(\):\s*Agent\[\];/u],
  ];
  const missing = requirements.filter(([,text,pattern])=>!pattern.test(withoutComments(text))).map(([label])=>label);
  return {kind:"timed + continued",missing};
}
function withoutComments(text) {return (text ?? "").replace(/\/\*[\s\S]*?\*\//gu,"");}
