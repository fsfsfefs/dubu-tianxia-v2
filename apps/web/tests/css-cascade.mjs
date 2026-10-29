import postcss from 'postcss';
import {createHash} from 'node:crypto';
export function cascadeDigest(sheets){
 const trees=sheets.map(css=>postcss.parse(css));
 for(const tree of trees)tree.walkRules(rule=>{rule.selector=rule.selector.replace(/:where\(\[data-feature="[^"]+"\]\)\s*/g,'');});
 const later=new Map();
 for(const tree of [...trees].reverse()){
  const rules=[];tree.walkRules(r=>rules.push(r));
  for(const rule of rules.reverse()){
   let context='';for(let p=rule.parent;p?.type!=='root';p=p.parent)context=`@${p.name} ${p.params}|${context}`;
   for(const decl of [...rule.nodes].reverse()){
    if(decl.type!=='decl')continue;
    const key=context+'|'+rule.selector+'|'+decl.prop+'|'+Boolean(decl.important);
    if(later.get(key)===decl.value)decl.remove();else later.set(key,decl.value);
   }
   if(!rule.nodes.length)rule.remove();
  }
 }
 const entries=[];
 for(const tree of trees)tree.walkRules(rule=>{
  let context='';for(let p=rule.parent;p?.type!=='root';p=p.parent)context=`@${p.name} ${p.params}|${context}`;
  entries.push([context,rule.selector,rule.nodes.filter(d=>d.type==='decl').map(d=>[d.prop,d.value,Boolean(d.important)])]);
 });
 return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
