// Declarative geometry: no executable expressions are accepted from imported scenes.
const ARRAYS = ['points','segments','lines','circles','angles'];
const KINDS = new Set(['free','onLine','onCircle','rotate','project','midpoint','intersection']);
const EPS = 1e-10;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const clone = o => structuredClone(o);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const radiusRef = item => item.through ?? (typeof item.radius === 'string' ? item.radius : null);
const deps = p => {
  switch(p.kind) {
    case 'free': return [];
    case 'onLine': case 'midpoint': return [p.from,p.to];
    case 'onCircle': return [p.center,...(radiusRef(p) ? [radiusRef(p)] : [])];
    case 'rotate': return [p.source,p.center];
    case 'project': return [p.point,p.from,p.to];
    case 'intersection': return [p.a,p.b,p.c,p.d];
    default:return [];
  }
};

function structureErrors(scene) {
  const errors=[];
  if(!object(scene)) return ['图形必须是对象'];
  if(scene.lineWidth!==undefined&&(!finite(scene.lineWidth)||scene.lineWidth<=0||scene.lineWidth>20))errors.push('线宽须为 0 到 20 的有限数值');
  const collections=[...ARRAYS,...(scene.constraints===undefined?[]:['constraints'])];
  for(const field of collections) if(!Array.isArray(scene[field])) errors.push(`${field} 必须是数组`);
  if(errors.length) return errors;
  if(collections.reduce((n,k)=>n+scene[k].length,0)>500) return ['图形元素不能超过 500 个'];
  const ids=new Set(), pointIds=new Set();
  for(const field of collections) for(const item of scene[field]) {
    if(!object(item)) {errors.push(`${field} 含无效元素`);continue;}
    if(typeof item.id!=='string'||!item.id.trim()||item.id.length>100) errors.push(`${field} 元素 id 必须是非空短文本`);
    else if(ids.has(item.id)) errors.push(`重复 id：${item.id}`);
    else ids.add(item.id);
    if(field==='points' && typeof item.id==='string') pointIds.add(item.id);
    if(item.visible!==undefined && typeof item.visible!=='boolean') errors.push(`${item.id} visible 必须是布尔值`);
    if(item.labelOffset!==undefined && (!Array.isArray(item.labelOffset)||item.labelOffset.length!==2||!item.labelOffset.every(finite))) errors.push(`${item.id} 标签偏移必须为两个有限数值`);
    if(item.width!==undefined && (!finite(item.width)||item.width<=0||item.width>20)) errors.push(`${item.id} 线宽须为 0 到 20 的有限数值`);
    if(item.lineWidth!==undefined && (!finite(item.lineWidth)||item.lineWidth<=0||item.lineWidth>20)) errors.push(`${item.id} 线宽须为 0 到 20 的有限数值`);
  }
  const ref=(id,owner)=>{if(typeof id!=='string'||!pointIds.has(id)) errors.push(`${owner} 引用了缺失的点：${String(id)}`);};
  const num=(n,label)=>{if(!finite(n)) errors.push(`${label} 必须是有限数值`);};
  const radius=(item)=>{
    const through=radiusRef(item);
    if(through!==null) ref(through,item.id);
    else if(!finite(item.radius)||item.radius<=0) errors.push(`${item.id} 半径必须为正有限数值`);
  };
  for(const p of scene.points.filter(object)) {
    if(!KINDS.has(p.kind)){errors.push(`${p.id} 点类型不受支持：${p.kind}`);continue;}
    for(const id of deps(p)) ref(id,p.id);
    if(p.kind==='free'){num(p.x,`${p.id}.x`);num(p.y,`${p.id}.y`);}
    if(p.kind==='onLine') num(p.t,`${p.id}.t`);
    if(p.kind==='onCircle'){num(p.angle,`${p.id}.angle`);radius(p);}
    if(p.kind==='rotate') num(p.angle,`${p.id}.angle`);
  }
  for(const field of ['segments','lines']) for(const item of scene[field].filter(object)){ref(item.from,item.id);ref(item.to,item.id);}
  for(const c of scene.circles.filter(object)){ref(c.center,c.id);radius(c);}
  for(const a of scene.angles.filter(object)){ref(a.a,a.id);ref(a.vertex,a.id);ref(a.b,a.id);if(a.right!==undefined&&typeof a.right!=='boolean') errors.push(`${a.id} right 必须是布尔值`);}
  for(const c of (scene.constraints??[]).filter(object)){
    if(c.kind!=='sameSide')errors.push(`${c.id} 约束类型不受支持：${c.kind}`);
    if(!Array.isArray(c.points)||c.points.length!==2)errors.push(`${c.id} 同侧约束必须指定两个点`);
    else for(const id of c.points)ref(id,c.id);
    ref(c.from,c.id);ref(c.to,c.id);
  }
  return [...new Set(errors)];
}

export function evaluateScene(scene) {
  const errors=structureErrors(scene), points=Object.create(null);
  if(errors.length) return {points,errors};
  const map=new Map(scene.points.map(p=>[p.id,p])), visiting=new Set(), failed=new Set();
  const line=(a,b,id)=>{
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if(length<EPS) throw new Error(`${id} 的直线退化：两个定义点重合`);
    return {dx,dy,length};
  };
  const get=id=>{
    if(Object.hasOwn(points,id)) return points[id];
    if(failed.has(id)) throw new Error(`${id} 依赖的构造无效`);
    if(visiting.has(id)) throw new Error(`点 ${id} 存在循环依赖`);
    visiting.add(id);
    const p=map.get(id); let result;
    try {
      const values=deps(p).map(get);
      switch(p.kind){
        case 'free':result={x:p.x,y:p.y};break;
        case 'onLine':{const [a,b]=values;const {dx,dy}=line(a,b,p.id);result={x:a.x+p.t*dx,y:a.y+p.t*dy};break;}
        case 'midpoint':{const [a,b]=values;result={x:(a.x+b.x)/2,y:(a.y+b.y)/2};break;}
        case 'rotate':{const [s,c]=values,r=p.angle*Math.PI/180,dx=s.x-c.x,dy=s.y-c.y;result={x:c.x+dx*Math.cos(r)-dy*Math.sin(r),y:c.y+dx*Math.sin(r)+dy*Math.cos(r)};break;}
        case 'onCircle':{const [c,t]=values,r=t?distance(c,t):p.radius,theta=p.angle*Math.PI/180;if(r<EPS)throw new Error(`${p.id} 半径退化`);result={x:c.x+r*Math.cos(theta),y:c.y+r*Math.sin(theta)};break;}
        case 'project':{const [s,a,b]=values,{dx,dy,length}=line(a,b,p.id),t=((s.x-a.x)*dx+(s.y-a.y)*dy)/(length*length);result={x:a.x+t*dx,y:a.y+t*dy};break;}
        case 'intersection':{const [a,b,c,d]=values,u=line(a,b,p.id),v=line(c,d,p.id),cross=u.dx*v.dy-u.dy*v.dx;if(Math.abs(cross)/(u.length*v.length)<EPS)throw new Error(`${p.id} 两条直线平行或重合，不能确定交点`);const t=((c.x-a.x)*v.dy-(c.y-a.y)*v.dx)/cross;result={x:a.x+t*u.dx,y:a.y+t*u.dy};break;}
      }
      if(!finite(result.x)||!finite(result.y)) throw new Error(`${id} 求值产生非有限坐标`);
      points[id]=result;return result;
    } catch(error){failed.add(id);throw error;} finally {visiting.delete(id);}
  };
  for(const p of scene.points) try{get(p.id);}catch(error){errors.push(error.message);}
  for(const item of [...scene.lines,...scene.segments]) try {if(points[item.from]&&points[item.to])line(points[item.from],points[item.to],item.id);}catch(error){errors.push(error.message);}
  for(const c of scene.circles){const through=radiusRef(c);if(through&&points[c.center]&&points[through]&&distance(points[c.center],points[through])<EPS)errors.push(`${c.id} 半径退化`);}
  for(const a of scene.angles) if(points[a.a]&&points[a.vertex]&&points[a.b]&&(distance(points[a.a],points[a.vertex])<EPS||distance(points[a.b],points[a.vertex])<EPS))errors.push(`${a.id} 角的边退化`);
  for(const c of scene.constraints??[])try{
    const a=points[c.from],b=points[c.to],p=points[c.points[0]],q=points[c.points[1]];
    if(!a||!b||!p||!q)continue;
    const {dx,dy,length}=line(a,b,c.id),ux=dx/length,uy=dy/length,side=v=>ux*(v.y-a.y)-uy*(v.x-a.x),s=side(p),t=side(q),product=s*t;
    if(!finite(s)||!finite(t)||!finite(product))throw new Error(`${c.id} 同侧约束求值产生非有限数值`);
    if(Math.abs(s)<EPS||Math.abs(t)<EPS||product<=0)throw new Error(`${c.points.join('、')} 必须位于直线 ${c.from}${c.to} 的同侧，且不能落在直线上`);
  }catch(error){errors.push(error.message);}
  return {points,errors:[...new Set(errors)]};
}

export function validateScene(scene) {
  try {return evaluateScene(scene).errors;} catch(error){return [`图形无效：${error.message}`];}
}

export function movePoint(scene,id,x,y) {
  if(!finite(x)||!finite(y))throw new Error('拖动坐标必须是有限数值');
  const {points,errors}=evaluateScene(scene);
  if(errors.length)throw new Error(errors.join('；'));
  const next=clone(scene), map=new Map(next.points.map(p=>[p.id,p]));
  const move=(pointId,px,py)=>{
    const p=map.get(pointId);
    if(!p)throw new Error(`找不到点 ${pointId}`);
    switch(p.kind){
      case 'free':p.x=px;p.y=py;break;
      case 'onLine':{const a=points[p.from],b=points[p.to],dx=b.x-a.x,dy=b.y-a.y;p.t=((px-a.x)*dx+(py-a.y)*dy)/(dx*dx+dy*dy);break;}
      case 'onCircle':{const c=points[p.center];if(Math.hypot(px-c.x,py-c.y)<EPS)throw new Error('不能拖到圆心：请指定圆上的方向');p.angle=Math.atan2(py-c.y,px-c.x)*180/Math.PI;break;}
      case 'rotate':{
        const sources=new Set();let cursor=p.source;
        while(cursor){sources.add(cursor);const item=map.get(cursor);cursor=item.kind==='rotate'?item.source:null;}
        const depends=id=>sources.has(id)||deps(map.get(id)).some(depends);
        if(depends(p.center))throw new Error(`点 ${p.id} 的旋转中心依赖可移动源点，请直接移动源点`);
        const c=points[p.center],r=-p.angle*Math.PI/180,dx=px-c.x,dy=py-c.y;move(p.source,c.x+dx*Math.cos(r)-dy*Math.sin(r),c.y+dx*Math.sin(r)+dy*Math.cos(r));break;}
      default:throw new Error(`点 ${pointId} 是${{project:'垂足',midpoint:'中点',intersection:'交点'}[p.kind]}，由依赖点决定；请拖动其源点`);
    }
  };
  move(id,x,y);
  const after=validateScene(next);
  if(after.length)throw new Error(after.join('；'));
  return next;
}

export function sceneBounds(scene,padding=0.18) {
  const {points,errors}=evaluateScene(scene);
  if(errors.length)return [-5,5,5,-5];
  const coords=scene.points.filter(p=>p.visible!==false).map(p=>points[p.id]);
  for(const c of scene.circles.filter(c=>c.visible!==false)){const p=points[c.center],through=radiusRef(c),r=through?distance(p,points[through]):c.radius;coords.push({x:p.x-r,y:p.y-r},{x:p.x+r,y:p.y+r});}
  if(!coords.length)return [-5,5,5,-5];
  const xs=coords.map(p=>p.x),ys=coords.map(p=>p.y),left=Math.min(...xs),right=Math.max(...xs),bottom=Math.min(...ys),top=Math.max(...ys),pad=Math.max(right-left,top-bottom,2)*padding;
  return [left-pad,top+pad,right+pad,bottom-pad];
}


