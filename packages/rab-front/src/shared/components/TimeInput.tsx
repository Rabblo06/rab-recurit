import {useEffect,useId,useRef,useState} from 'react';
import {IconClock} from '@tabler/icons-react';
import Popover from './Popover';
import './time-input.css';
const pad=(n:number)=>String(n).padStart(2,'0');
export default function TimeInput({value,onChange,label}:{value:string;onChange:(value:string)=>void;label:string}){
 const id=useId(),anchor=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const [open,setOpen]=useState(false),[text,setText]=useState(value),[error,setError]=useState(false);
 useEffect(()=>{setText(value);setError(false);},[value]);
 const choose=(part:'hour'|'minute',next:string)=>{const [hour='00',minute='00']=value.split(':');const result=part==='hour'?next+':'+(minute||'00'):(hour||'00')+':'+next;onChange(result);setText(result);setError(false);};
 return <div className="crew-time-field"><div ref={anchor} className="crew-time-input"><input id={id} aria-label={label} aria-invalid={error} aria-describedby={error?id+'-error':undefined} inputMode="numeric" placeholder="HH:MM" value={text} onChange={e=>{setText(e.target.value);setError(false);}} onBlur={()=>{if(!text){onChange('');return;}if(/^([01]\d|2[0-3]):[0-5]\d$/.test(text)){onChange(text);setError(false);}else {setError(true);setText(value);}}}/><button ref={trigger} type="button" aria-label={'Choose '+label.toLowerCase()} aria-expanded={open} onClick={()=>setOpen(!open)}><IconClock size={15}/></button></div>{error&&<small id={id+'-error'} role="alert">Use HH:MM (24-hour time).</small>}
 <Popover open={open} onClose={()=>setOpen(false)} anchorRef={anchor} minWidth={216} className="crew-time-popover" onEscape={()=>{setOpen(false);trigger.current?.focus();return true;}}>
 <div className="crew-time-columns">{(['hour','minute'] as const).map((part,index)=><div key={part}><span>{part==='hour'?'Hour':'Minute'}</span><div className="crew-time-options" role="group" aria-label={part==='hour'?'Hours':'Minutes'}>{Array.from({length:index?60:24},(_,n)=>pad(n)).map(option=><button type="button" key={option} aria-label={part+' '+option} aria-pressed={value.split(':')[index]===option} ref={node=>{if(node&&value.split(':')[index]===option)node.scrollIntoView({block:'nearest'});}} onClick={()=>choose(part,option)}>{option}</button>)}</div></div>)}</div>
 </Popover></div>;
}
