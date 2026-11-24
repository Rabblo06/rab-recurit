import type { CSSProperties } from 'react';
const tones = [
 {bg:'#e9efc9',color:'#526619'}, {bg:'#f5ddf4',color:'#843c85'},
 {bg:'#d5f0e9',color:'#226c5c'}, {bg:'#e8e1fa',color:'#665095'},
 {bg:'#d9effa',color:'#286781'}, {bg:'#f9e4d3',color:'#885323'},
];
/** Stable pastel identity colour across tables, independent of row order. */
export function recordAvatarColor(name: string = '') {
 const hash = Array.from(name.trim().toLowerCase()).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
 return tones[hash % tones.length];
}
export function recordAvatarStyle(name: string = '') {const tone=recordAvatarColor(name);return {background:tone.bg,color:tone.color,'--record-avatar-bg':tone.bg,'--record-avatar-fg':tone.color} as CSSProperties;}
