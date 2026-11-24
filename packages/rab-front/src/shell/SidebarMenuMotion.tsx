import { useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { motionTokens } from '../shared/components/arc/motion-tokens';
/** Arc morph-select's moving highlight, adapted to an action menu (not a listbox). */
export default function SidebarMenuMotion({children}:{children:ReactNode}) {
 const root=useRef<HTMLDivElement>(null);const reduced=useReducedMotion();
 const [box,setBox]=useState<{x:number;y:number;width:number;height:number}|null>(null);
 const follow=(target:EventTarget|null)=>{const node=target instanceof Element?target.closest<HTMLButtonElement>('button[role="menuitem"]'):null;const parent=root.current;if(!node||!parent||node.disabled){setBox(null);return;}const a=node.getBoundingClientRect(),b=parent.getBoundingClientRect();setBox({x:a.left-b.left,y:a.top-b.top,width:a.width,height:a.height});};
 return <motion.div layout="size" transition={reduced?{duration:0}:motionTokens.spring.morph} ref={root} className="sidebar-morph-menu" onPointerMove={e=>follow(e.target)} onFocusCapture={e=>follow(e.target)} onPointerLeave={()=>setBox(null)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setBox(null)}}>
 {box&&<motion.span className="sidebar-morph-highlight" aria-hidden="true" initial={false} animate={box} transition={reduced?{duration:0}:motionTokens.spring.morph}/>}{children}</motion.div>;
}
