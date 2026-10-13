import {parsePetAnswer,type PetAnswer,type PetInteraction} from "@starcried/starlite-dsh-protocol";

/** Drafts exist only in this DOM instance, never storage or logs. */
export function createQuestionForm(request:PetInteraction,submit:(answer:PetAnswer)=>Promise<void>):HTMLFormElement{
  const form=document.createElement("form");form.className="question-form";form.autocomplete="off";
  const rows=request.questions.map((question,index)=>{
    const group=document.createElement("fieldset"),legend=document.createElement("legend");
    legend.textContent=question.header?`${question.header} · ${question.question}`:question.question;group.append(legend);
    if(question.detail){const details=document.createElement("details"),summary=document.createElement("summary"),text=document.createElement("p");summary.textContent="查看详情";text.textContent=question.detail;details.append(summary,text);group.append(details)}
    const inputs=question.options.map(option=>{
      const label=document.createElement("label"),input=document.createElement("input"),text=document.createElement("span");
      input.type=question.multiSelect?"checkbox":"radio";input.name=`question-${index}`;input.value=option.label;
      text.textContent=option.label;if(option.description){const description=document.createElement("small");description.textContent=option.description;text.append(description)}
      label.append(input,text);group.append(label);return input;
    });
    const label=document.createElement("label"),custom=document.createElement("textarea");label.className="question-custom";
    label.append(question.options.length?"自定义回答":"你的回答");custom.rows=2;custom.maxLength=8192;custom.setAttribute("aria-label",`${question.header??question.question}：自定义回答`);label.append(custom);group.append(label);
    custom.addEventListener("input",()=>{if(!question.multiSelect&&custom.value.trim())inputs.forEach(input=>{input.checked=false});update()});
    inputs.forEach(input=>input.addEventListener("change",()=>{if(!question.multiSelect&&input.checked)custom.value="";update()}));
    form.append(group);return {question,inputs,custom};
  });
  const button=document.createElement("button"),status=document.createElement("span");button.type="submit";button.textContent="提交回答";status.className="question-status";status.setAttribute("role","status");form.append(button,status);
  let sending=false,finished=false;
  const answer=():PetAnswer=>parsePetAnswer({requestId:request.requestId,sessionRef:request.sessionRef,answers:rows.map(({question,inputs,custom})=>({id:question.id,selected:inputs.filter(input=>input.checked).map(input=>input.value),...(custom.value.trim()?{custom:custom.value.trim()}: {})}))},request);
  function update():void{try{answer();button.disabled=sending||finished}catch{button.disabled=true}}
  form.addEventListener("submit",async event=>{
    event.preventDefault();if(sending||finished||button.disabled)return;
    const value=answer();sending=true;status.textContent="正在提交…";
    rows.forEach(({inputs,custom})=>{inputs.forEach(input=>{input.disabled=true});custom.disabled=true});update();
    try{await submit(value);finished=true;status.textContent="已提交";}
    catch{status.textContent="未能提交。可重试，或转到 DSH 回答。";rows.forEach(({inputs,custom})=>{inputs.forEach(input=>{input.disabled=false});custom.disabled=false})}
    finally{sending=false;update()}
  });
  update();return form;
}
