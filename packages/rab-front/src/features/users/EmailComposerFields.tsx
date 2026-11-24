import ToggleGroup from '../../shared/components/arc/toggle-group/toggle-group';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronLeft, IconChevronDown, IconMaximize, IconPaperclip, IconSend, IconTrash, IconX } from '@tabler/icons-react';
import './email-compose.css';

/** Interactive design preview only: no new delivery capabilities or network writes. */
export default function EmailComposerFields({recipients,subject,message,onSubjectChange,onMessageChange,disabled=false,onBack}:{onBack?:()=>void;recipients:string[];subject:string;message:string;onSubjectChange:(value:string)=>void;onMessageChange:(value:string)=>void;disabled?:boolean}) {
 const id=useId();
 const [copies,setCopies]=useState(false);
 const [copyValues,setCopyValues]=useState<Record<string,string>>({Cc:'',Bcc:''});
 const [to,setTo]=useState(recipients);
 const [expanded,setExpanded]=useState(false);
 const [commands,setCommands]=useState(false);
 const [active,setActive]=useState(0);
 const [files,setFiles]=useState<File[]>([]);
 const [notice,setNotice]=useState('');
 const editor=useRef<HTMLDivElement | null>(null);
 const fileInput=useRef<HTMLInputElement>(null);
 const expandButton=useRef<HTMLButtonElement>(null);
 const savedHtml=useRef('');
 const savedSelection=useRef<Range | null>(null);
 const options=[['H₁','Heading 1','h1'],['H₂','Heading 2','h2'],['H₃','Heading 3','h3'],['❝','Quote','blockquote'],['☷','Bullet List','ul']];
 const sync=()=>{savedHtml.current=editor.current?.innerHTML??'';onMessageChange(editor.current?.innerText??'');};
 const switchView=(value:boolean)=>{sync();setCommands(false);setExpanded(value);};
 const attachEditor=(node:HTMLDivElement|null)=>{editor.current=node;if(node && !node.innerHTML){if(savedHtml.current)node.innerHTML=savedHtml.current;else node.textContent=message;}};
 const format=(tag:string)=>{
   const selection=window.getSelection();editor.current?.focus();if(savedSelection.current){selection?.removeAllRanges();selection?.addRange(savedSelection.current);}
   // The browser editing commands preserve the current selection and undo history.
   document.execCommand('delete');
   if(tag==='ul')document.execCommand('insertUnorderedList');else document.execCommand('formatBlock',false,tag);
   setCommands(false);sync();
 };
 const body=<div className="email-preview-body">
   {!expanded && <button ref={expandButton} className="btn-icon email-expand" type="button" aria-label="Expand text editor" onClick={()=>switchView(true)}><IconMaximize size={15}/></button>}
   <div ref={attachEditor} contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label="Message" aria-multiline="true" data-placeholder="Type anything or press / for commands" className="email-rich-editor"
     onInput={()=>{sync();const selection=window.getSelection();const range=selection?.rangeCount?selection.getRangeAt(0):null;const text=range?.startContainer.textContent??'';const offset=range?.startOffset??0;if(text.slice(0,offset).endsWith('/')){const slash=range!.cloneRange();slash.setStart(slash.startContainer,Math.max(0,offset-1));savedSelection.current=slash;setCommands(true);setActive(0);}else setCommands(false);}}
     onPaste={event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));sync();}}
     onKeyDown={event=>{if(commands && ['ArrowDown','ArrowUp','Enter','Escape'].includes(event.key)){event.preventDefault();event.stopPropagation();if(event.key==='Escape')setCommands(false);else if(event.key==='Enter')format(options[active][2]);else setActive(index=>(index+(event.key==='ArrowDown'?1:options.length-1))%options.length);}if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();setNotice('Preview only — email sending is disabled.');}}}/>
   {commands && <div role="menu" aria-label="Formatting commands" className="email-command-menu">{options.map(([icon,label,tag],index)=><button role="menuitem" key={tag} type="button" className={active===index?'is-active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>format(tag)}><span>{icon}</span>{label}</button>)}</div>}
 </div>;
 return <div className="crewflow-email-fields email-preview">
   <div className="email-preview-title">{onBack&&<button type="button" className="btn-icon" aria-label="Back to messages" onClick={onBack}><IconChevronLeft size={15}/></button>}New Email<span className="email-preview-tag">UI preview</span></div>
   <div className="crewflow-email-line"><span className="crewflow-email-label">From</span><span className="email-sender">Workspace sender</span><IconChevronDown size={14} aria-hidden="true"/></div>
   <div className="crewflow-email-line"><span className="crewflow-email-label">To</span><div className="crewflow-email-recipients">{to.map((recipient,index)=><span className="crewflow-email-recipient" key={recipient+index} title={recipient}><span className="crewflow-email-initial">{recipient.trim()[0]}</span><span>{recipient.split(' <')[0]}</span><button type="button" aria-label={'Remove '+recipient} onClick={()=>setTo(current=>current.filter((_,i)=>i!==index))}><IconX size={12}/></button></span>)}{!to.length&&<button type="button" className="email-text-button" onClick={()=>setTo(recipients)}>Restore recipients</button>}</div><ToggleGroup type="multiple" label="Recipient fields" size="sm" value={copies ? ["copies"] : []} onValueChange={values=>setCopies(values.includes("copies"))}><ToggleGroup.Item value="copies" label="Cc/Bcc" aria-expanded={copies}>Cc/Bcc</ToggleGroup.Item></ToggleGroup></div>
   {copies && <>{['Cc','Bcc'].map(label=><div className="crewflow-email-line" key={label}><label className="crewflow-email-label" htmlFor={id+label}>{label}</label><input id={id+label} type="text" placeholder="" autoComplete="off" aria-label={label} value={copyValues[label]} onChange={event=>setCopyValues(previous=>({...previous,[label]:event.target.value}))}/></div>)}</>}
   <div className="crewflow-email-line"><label className="crewflow-email-label" htmlFor={id+'subject'}>Subject</label><input id={id+'subject'} disabled={disabled} value={subject} onChange={e=>onSubjectChange(e.target.value)}/></div>
   {!expanded&&body}
   {expanded&&createPortal(<div className="email-fullscreen" role="dialog" aria-modal="true" aria-label="Text Editor" onKeyDown={event=>{if(event.key==='Escape'&&!commands){event.preventDefault();event.stopPropagation();switchView(false);requestAnimationFrame(()=>expandButton.current?.focus());}if(event.key==='Tab'){const buttons=event.currentTarget.querySelectorAll<HTMLElement>('button,[contenteditable="true"]');const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}><header><button autoFocus type="button" className="btn-icon" aria-label="Close text editor" onClick={()=>switchView(false)}><IconX size={16}/></button>Text Editor</header>{body}</div>,document.body)}
   {!!files.length&&<div className="email-local-files">{files.map((file,index)=><span key={index}>{file.name}<button type="button" aria-label={'Remove attachment '+file.name} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}><IconX size={12}/></button></span>)}</div>}
   <span className="visually-hidden" role="status">{notice}</span>
   <footer className="email-preview-footer"><input ref={fileInput} type="file" multiple hidden onChange={e=>{setFiles(current=>[...current,...Array.from(e.target.files??[])]);e.target.value='';}}/><button type="button" className="btn-icon" aria-label="Clear preview draft" onClick={()=>{onSubjectChange('');onMessageChange('');savedHtml.current='';if(editor.current)editor.current.innerHTML='';setFiles([]);setCopyValues({Cc:'',Bcc:''});setTo(recipients);setNotice('Preview draft cleared.');}}><IconTrash size={16}/></button><button type="button" className="btn-icon" aria-label="Attach local preview files" onClick={()=>fileInput.current?.click()}><IconPaperclip size={16}/></button><button className="email-preview-send" type="button" disabled title="Sending is disabled in this UI preview"><IconSend size={14}/>Send <span>Ctrl ↵</span></button></footer>
 </div>;
}
