import { useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { motionTokens } from '../shared/components/arc/motion-tokens';
import './cookie-notice.css';
const KEY='crewflow.cookie-notice.v1';
/** Arc cookie-consent's compact-to-panel pattern, adapted to the storage actually in use.
 * No optional analytics/marketing switches: no such tracker integration was found. */
export default function CookieNotice(){
 const [seen,setSeen]=useState(()=>{try{return localStorage.getItem(KEY)==='acknowledged'}catch{return false}});
 const [open,setOpen]=useState(false);const trigger=useRef<HTMLButtonElement>(null);const reduced=useReducedMotion();
 const close=()=>{setOpen(false);requestAnimationFrame(()=>trigger.current?.focus())};
 const acknowledge=()=>{try{localStorage.setItem(KEY,'acknowledged')}catch{/* The choice remains in this page session. */}setSeen(true);close()};
 if(seen)return null;
 return <motion.aside className="cookie-notice" aria-label="Cookies and storage" layout transition={reduced?{duration:0}:motionTokens.spring.morph}>
 <AnimatePresence initial={false} mode="wait">{open?<motion.div key="details" initial={reduced?false:{opacity:0,y:4}} animate={{opacity:1,y:0}} exit={{opacity:0}} onKeyDown={e=>{if(e.key==='Escape')close()}}>
 <h2>Cookies and storage</h2><p>Sign-in and security use essential cookies. Display and workspace preferences are saved in your browser. This notice does not enable analytics or advertising trackers.</p><p><strong>Essential storage — always on</strong></p><button type="button" className="btn btn-dark" autoFocus onClick={acknowledge}>Got it</button><button type="button" className="btn btn-outline" onClick={close}>Close</button>
 </motion.div>:<motion.div key="compact" initial={false} animate={{opacity:1}} exit={{opacity:0}}>{!seen&&<p>We use essential cookies and browser storage to run Crewflow.</p>}<button ref={trigger} type="button" className="btn btn-outline" aria-expanded={open} onClick={()=>setOpen(true)}>Cookies and storage</button>{!seen&&<button type="button" className="btn btn-dark" onClick={acknowledge}>Got it</button>}</motion.div>}</AnimatePresence>
 </motion.aside>;
}
