import DateInput from '../components/DateInput';
import DateRangePicker from '../components/arc/date-range-picker/date-range-picker';
import FilterToolbar, { type FilterChip } from '../components/arc/filter-toolbar/filter-toolbar';
import { motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { IconX } from '@tabler/icons-react';
import type { ActiveFilters, FilterFieldConfig } from './types';

function FilterValueControl({
  field,
  value,
  onChange,
}: {
  field: FilterFieldConfig;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === 'date') {
    return <DateInput value={value} onChange={onChange} ariaLabel={field.label} />;
  }
  return (
    <input
      type="text"
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-label={field.label}
    />
  );
}

function RangeValueControl({
  field,
  from,
  to,
  onChangeFrom,
  onChangeTo,
  onRangeChange,
}: {
  field: FilterFieldConfig;
  from: string;
  to: string;
  onChangeFrom: (v: string) => void;
  onChangeTo: (v: string) => void;
  onRangeChange: (from: string, to: string) => void;
}) {
  const inputType = field.type === 'dateRange' ? 'date' : 'number';
  const parse = (value: string) => { const [y,m,d]=value.split('-').map(Number); return new Date(y,m-1,d); };
  const iso = (date: Date) => [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  return (
    <>
      {field.type === "dateRange" && <DateRangePicker className="filter-date-range" label={`${field.label} range`} months={1} weekStartsOn={1} locale="en-GB" value={from && to ? {start:parse(from),end:parse(to)} : null} onChange={range=>onRangeChange(iso(range.start),iso(range.end))} />}
      {field.type === 'dateRange' ? <div className="filter-date-bounds"><div><span>From</span><DateInput value={from} onChange={onChangeFrom} ariaLabel={field.label + ' from'} /></div><div><span>To</span><DateInput value={to} onChange={onChangeTo} ariaLabel={field.label + ' to'} /></div></div> : <>
      <input type={inputType} value={from} onChange={(e) => onChangeFrom(e.target.value)} aria-label={`${field.label} from`} style={{ width: 90 }} />
      <span style={{ color: 'var(--font-tertiary)', fontSize: 11 }}>to</span>
      <input type={inputType} value={to} onChange={(e) => onChangeTo(e.target.value)} aria-label={`${field.label} to`} style={{ width: 90 }} />
      </>}
    </>
  );
}


/** Arc's field/value menu keeps API keys separate from display labels. */
export default function FilterPopover({fields,active,onChange}:{fields:FilterFieldConfig[];active:ActiveFilters;onChange:(next:ActiveFilters)=>void}) {
 const reduced=useReducedMotion();const [extraRows,setExtraRows]=useState<string[]>([]);
 const isRange=(field:FilterFieldConfig)=>field.type==='dateRange'||field.type==='numberRange';
 const hasValue=(field:FilterFieldConfig)=>isRange(field)?Boolean(active[field.key+'From']||active[field.key+'To']):Boolean(active[field.key]);
 const remove=(id:string)=>{const field=fields.find(f=>f.key===id);if(!field)return;const next={...active};delete next[id];if(isRange(field)){delete next[id+'From'];delete next[id+'To'];}setExtraRows(rows=>rows.filter(key=>key!==id));onChange(next);};
 const chips:FilterChip[]=fields.filter(hasValue).map(field=>({id:field.key,label:field.label,value:isRange(field)?[active[field.key+'From']||'Any',active[field.key+'To']||'Any'].join(' – '):field.options?.find(option=>option.value===active[field.key])?.label??active[field.key]}));
 const menuFields=fields.map(field=>({id:field.key,label:field.label,options:field.type==='select'?(field.options??[]):[{value:'__edit',label:'Set value…'}]}));
 const editFields=fields.filter(field=>field.type!=='select'&&(hasValue(field)||extraRows.includes(field.key)));
 return <section className="web-filter-toolbar" aria-label="Filters">
  <div className="rab-popover-title">Filter</div>
  <FilterToolbar filters={chips} onRemove={remove} onClearAll={()=>{setExtraRows([]);onChange({});}} addFilter={{fields:menuFields,align:'start',label:'Add filter',onAdd:chip=>{const field=fields.find(f=>f.key===chip.id);if(!field)return;if(field.type==='select'){onChange({...active,[field.key]:chip.rawValue??''});}else setExtraRows(rows=>rows.includes(field.key)?rows:[...rows,field.key]);}}}/>
  {editFields.map(field=><motion.div className="filter-row filter-value-row" key={field.key} initial={reduced?false:{opacity:0,y:4}} animate={{opacity:1,y:0}} transition={{duration:reduced?0:.2}}>
   <span className="filter-field-label">{field.label}</span>
   {isRange(field)?<RangeValueControl field={field} from={active[field.key+'From']??''} to={active[field.key+'To']??''} onChangeFrom={value=>onChange({...active,[field.key+'From']:value})} onChangeTo={value=>onChange({...active,[field.key+'To']:value})} onRangeChange={(from,to)=>onChange({...active,[field.key+'From']:from,[field.key+'To']:to})}/>:<FilterValueControl field={field} value={active[field.key]??''} onChange={value=>onChange({...active,[field.key]:value})}/>}
   <button type="button" className="filter-row-remove" aria-label={'Remove '+field.label+' filter'} onClick={()=>remove(field.key)}><IconX size={13}/></button>
  </motion.div>)}
 </section>;
}
