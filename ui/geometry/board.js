import { evaluateScene, validateScene, movePoint, sceneBounds } from './geometry.js';

const clone=value=>structuredClone(value);
const escapeXml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const tools={move:'拖动蓝色点；绿色约束点随源点联动。',point:'点击空白位置添加自由点。',segment:'依次点击线段的两个端点。',line:'依次点击直线上的两个点。',circle:'依次点击圆心和圆上一点。',perpendicular:'依次点击待作垂线的点、直线的两个定义点。',midpoint:'依次点击两个端点，构造中点。',delete:'点击要删除的点；依赖此点的构造也会删除。'};
const refs=p=>[p.from,p.to,p.source,p.center,p.point,p.a,p.b,p.c,p.d,p.vertex,p.through,typeof p.radius==='string'?p.radius:null,...(Array.isArray(p.points)?p.points:[])].filter(v=>typeof v==='string');
const radius=(c,p)=>c.through?Math.hypot(p[c.through].x-p[c.center].x,p[c.through].y-p[c.center].y):typeof c.radius==='string'?Math.hypot(p[c.radius].x-p[c.center].x,p[c.radius].y-p[c.center].y):c.radius;
const width=(item,scene)=>item.lineWidth??item.width??scene.lineWidth??2;
const angleRadius=(item,points)=>Math.min(.14,Math.hypot(points[item.a].x-points[item.vertex].x,points[item.a].y-points[item.vertex].y)*.08,Math.hypot(points[item.b].x-points[item.vertex].x,points[item.b].y-points[item.vertex].y)*.08);

// Label offsets are screen pixels with a positive Y pointing up. An explicit
// offset records the source drawing (or a user's edit) and always takes priority.
// For newly constructed points, choose a free sector using the current geometry.
export function pointLabelOffset(scene,point,points) {
  if(point.labelOffset!==undefined)return point.labelOffset;
  const positions=points??evaluateScene(scene).points;
  const at=positions[point.id];
  if(!at)return [-22,18];
  const visible=scene.points.filter(p=>p.visible!==false).map(p=>positions[p.id]).filter(Boolean);
  const center=visible.reduce((v,p)=>({x:v.x+p.x/visible.length,y:v.y+p.y/visible.length}),{x:0,y:0});
  const edges=[...scene.segments,...scene.lines].filter(e=>e.visible!==false&&(e.from===point.id||e.to===point.id));
  const directions=[[-24,18],[12,18],[-24,-18],[12,-18],[-7,25],[-7,-25],[-29,0],[14,0]];
  const norm=(x,y)=>{const d=Math.hypot(x,y);return d>1e-9?[x/d,y/d]:[0,0];};
  const outward=norm(at.x-center.x,at.y-center.y);
  let best=directions[0],bestScore=-Infinity;
  for(const offset of directions){
    // Text starts at X, so its visible centre lies slightly to the right.
    const direction=norm(offset[0]+7,offset[1]);
    let score=1.6*(direction[0]*outward[0]+direction[1]*outward[1]);
    for(const edge of edges){
      const other=positions[edge.from===point.id?edge.to:edge.from];
      if(!other)continue;
      const toward=norm(other.x-at.x,other.y-at.y);
      const alignment=direction[0]*toward[0]+direction[1]*toward[1];
      score-=2.5*Math.max(0,alignment)**2;
    }
    if(score>bestScore){bestScore=score;best=offset;}
  }
  return best;
}

// Retain the established 17 px labels unless a responsive canvas is too small
// to contain their fixed offsets, glyphs and the viewport's safety band.
export const displayTypographyScale=(w,h)=>Math.max(.1,Math.min(1,(w-16)/64,(h-16)/64));

let textCanvas;
const textWidth=(text,fontSize)=>{
  const value=String(text),fallback=[...value].reduce((sum,c)=>sum+fontSize*(c.charCodeAt(0)>255?1:.7),0);
  textCanvas??=typeof OffscreenCanvas==='function'?new OffscreenCanvas(1,1):globalThis.document?.createElement('canvas');
  const context=textCanvas?.getContext('2d');
  if(!context)return fallback;
  context.font=`${fontSize}px Arial, "Microsoft YaHei", sans-serif`;
  return Math.max(fallback,context.measureText(value).width);
};

// Geometry scales in world units; letter offsets and sizes remain screen pixels.
// Solve both together instead of reserving a percentage of the geometry span.
function fittedSceneViewport(scene,w,h,{fontSize=17,offsetUnit=1,segmentFontSize=17,segmentOffsetUnit=1,segmentDefaultOffset=[0,12],pointRadius=5,strokeUnit=1}={}) {
  const {points,errors}=evaluateScene(scene),[left,top,right,bottom]=sceneBounds(scene,0);
  const strokePadding=Math.max(1,...['segments','lines','circles','angles'].flatMap(field=>scene?.[field]??[]).filter(item=>item?.visible!==false).map(item=>width(item,scene)))*strokeUnit/2;
  const boxes=[{x:left,y:-top,left:-strokePadding,right:strokePadding,top:-strokePadding,bottom:strokePadding},{x:right,y:-bottom,left:-strokePadding,right:strokePadding,top:-strokePadding,bottom:strokePadding}];
  const label=(at,text,offset,size,unit,centered=false)=>{
    const width=textWidth(text,size),x=offset[0]*unit,y=-offset[1]*unit;
    boxes.push({x:at.x,y:-at.y,left:x-(centered?width/2:0),right:x+(centered?width/2:width),top:y-size*.75,bottom:y+size*.75});
  };
  for(const point of (errors.length?[]:scene.points).filter(p=>p.visible!==false)){
    const at=points[point.id];
    boxes.push({x:at.x,y:-at.y,left:-pointRadius,right:pointRadius,top:-pointRadius,bottom:pointRadius});
    label(at,point.label??point.id,pointLabelOffset(scene,point,points),fontSize,offsetUnit);
  }
  for(const segment of (errors.length?[]:scene.segments).filter(item=>item.visible!==false&&item.label!==undefined&&item.label!==false)){
    const a=points[segment.from],b=points[segment.to];
    label({x:(a.x+b.x)/2,y:(a.y+b.y)/2},segment.label,segment.labelOffset??segmentDefaultOffset,segmentFontSize,segmentOffsetUnit,true);
  }
  const padding=8,availableX=Math.max(1,w-2*padding),availableY=Math.max(1,h-2*padding);
  let minScale=0,maxScale=Infinity;
  for(const [axis,low,high,available]of[['x','left','right',availableX],['y','top','bottom',availableY]])for(const a of boxes)for(const b of boxes){
    const distance=a[axis]-b[axis],space=available-a[high]+b[low];
    if(distance>1e-12)maxScale=Math.min(maxScale,space/distance);
    else if(distance< -1e-12)minScale=Math.max(minScale,space/distance);
    else if(space<0)maxScale=-1;
  }
  // A label wider than the entire host cannot fit at any geometry scale. Keep a
  // usable drawing; the print compositor still expands to measured label ink.
  const fallback=Math.min(availableX/Math.max(right-left,1),availableY/Math.max(top-bottom,1));
  const scale=Number.isFinite(maxScale)&&maxScale>0&&maxScale>=minScale?maxScale:Math.max(1e-6,fallback);
  const extent=(axis,low,high)=>[Math.min(...boxes.map(b=>b[axis]*scale+b[low])),Math.max(...boxes.map(b=>b[axis]*scale+b[high]))];
  const [x0,x1]=extent('x','left','right'),[y0,y1]=extent('y','top','bottom');
  const tx=(w-x1-x0)/2,ty=(h-y1-y0)/2;
  return {scale,xy:p=>[p.x*scale+tx,-p.y*scale+ty],bounds:[-tx/scale,ty/scale,(w-tx)/scale,(ty-h)/scale]};
}

// Generate a standalone vector from the canonical model, never from editing DOM.
export function exportSceneSvg(scene,options={}) {
  const {points,errors}=evaluateScene(scene);
  if(errors.length)throw new Error(`图形无效，不能导出：${errors.join('；')}`);
  const w=options.width??1000,h=options.height??750;
  if(typeof w!=='number'||typeof h!=='number'||!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)throw new Error('导出尺寸必须为正有限数值');
  const unit=Math.min(w/1000,h/750),fontSize=options.fontSize??40*unit,strokeUnit=options.strokeScale??w/1000;
  if(![fontSize,strokeUnit].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0))throw new Error('导出字号和线宽比例必须为正有限数值');
  const labelUnit=fontSize/40;
  const {scale,xy,bounds}=fittedSceneViewport(scene,w,h,{fontSize,offsetUnit:fontSize/17,segmentFontSize:fontSize*38/40,segmentOffsetUnit:labelUnit,segmentDefaultOffset:[0,24],pointRadius:options.fontSize===undefined?0:5,strokeUnit});
  // Clip infinite lines to the mathematical viewport with no arbitrary long endpoints.
  const [left,top,right,bottom]=bounds;
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="几何图形"><rect width="${w}" height="${h}" fill="white"/><g fill="none" stroke="#172334" stroke-linecap="round" stroke-linejoin="round">`];
  const line=(a,b,item,kind)=>{const [x1,y1]=xy(a),[x2,y2]=xy(b);parts.push(`<path data-geometry="${kind}" d="M${x1} ${y1}L${x2} ${y2}" stroke-width="${width(item,scene)*strokeUnit}"/>`);};
  for(const item of scene.lines.filter(x=>x.visible!==false)){
    const a=points[item.from],b=points[item.to],dx=b.x-a.x,dy=b.y-a.y,candidates=[];
    if(Math.abs(dx)>1e-12)for(const x of [left,right]){const y=a.y+(x-a.x)*dy/dx;if(y>=bottom-1e-8&&y<=top+1e-8)candidates.push({x,y});}
    if(Math.abs(dy)>1e-12)for(const y of [bottom,top]){const x=a.x+(y-a.y)*dx/dy;if(x>=left-1e-8&&x<=right+1e-8)candidates.push({x,y});}
    const distinct=candidates.filter((p,i)=>!candidates.slice(0,i).some(q=>Math.hypot(p.x-q.x,p.y-q.y)<1e-8));
    let ends=null,longest=0;
    for(let i=0;i<distinct.length;i++)for(let j=i+1;j<distinct.length;j++){
      const length=Math.hypot(distinct[i].x-distinct[j].x,distinct[i].y-distinct[j].y);
      if(length>longest){longest=length;ends=[distinct[i],distinct[j]];}
    }
    if(ends){line(ends[0],ends[1],item,'line');if(item.label!==false){const a0=xy(ends[0]),b0=xy(ends[1]);parts.push(`<text x="${a0[0]*.18+b0[0]*.82}" y="${a0[1]*.18+b0[1]*.82-18*labelUnit}" stroke="none" fill="#172334" font-family="Arial, sans-serif" font-size="${36*labelUnit}" font-style="italic">${escapeXml(item.label??item.id)}</text>`);}}
  }
  for(const item of scene.segments.filter(x=>x.visible!==false)){
    const a=points[item.from],b=points[item.to];line(a,b,item,'segment');
    if(item.label!==undefined&&item.label!==false){
      const [x,y]=xy({x:(a.x+b.x)/2,y:(a.y+b.y)/2}),offset=item.labelOffset??[0,24];
      parts.push(`<text data-geometry="segment-label" x="${x+offset[0]*labelUnit}" y="${y-offset[1]*labelUnit}" stroke="none" fill="#172334" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Microsoft YaHei, sans-serif" font-size="${38*labelUnit}">${escapeXml(item.label)}</text>`);
    }
  }
  for(const item of scene.circles.filter(x=>x.visible!==false)){const [cx,cy]=xy(points[item.center]);parts.push(`<circle data-geometry="circle" cx="${cx}" cy="${cy}" r="${radius(item,points)*scale}" stroke-width="${width(item,scene)*strokeUnit}"/>`);}
  for(const item of scene.angles.filter(x=>x.visible!==false)){
    const a=xy(points[item.a]),v=xy(points[item.vertex]),b=xy(points[item.b]),u=[a[0]-v[0],a[1]-v[1]],z=[b[0]-v[0],b[1]-v[1]],lu=Math.hypot(...u),lz=Math.hypot(...z),r=item.right?Math.min(10*unit,angleRadius(item,points)*scale):Math.min(24*unit,lu*.23,lz*.23),p=[v[0]+u[0]/lu*r,v[1]+u[1]/lu*r],q=[v[0]+z[0]/lz*r,v[1]+z[1]/lz*r];
    const path=item.right?`M${p[0]} ${p[1]}L${p[0]+q[0]-v[0]} ${p[1]+q[1]-v[1]}L${q[0]} ${q[1]}`:`M${p[0]} ${p[1]}A${r} ${r} 0 0 ${u[0]*z[1]-u[1]*z[0]>0?1:0} ${q[0]} ${q[1]}`;
    parts.push(`<path data-geometry="angle" d="${path}" stroke-width="${Math.max(1,width(item,scene)*.8)*strokeUnit}"/>`);
  }
  parts.push(`</g><g fill="#172334" font-size="${fontSize}" font-family="Arial, Microsoft YaHei, sans-serif">`);
  // SVG letters are 40 units versus 17 px in JSXGraph. Scale their offsets by
  // the same ratio so the label/letter gap and chosen side survive export.
  const labelOffsetUnit=fontSize/17;
  for(const p of scene.points.filter(x=>x.visible!==false)){const [x,y]=xy(points[p.id]),offset=pointLabelOffset(scene,p,points);parts.push(`<text x="${x+offset[0]*labelOffsetUnit}" y="${y-offset[1]*labelOffsetUnit}" dominant-baseline="middle">${escapeXml(p.label??p.id)}</text>`);}
  return parts.join('')+'</g></svg>';
}

export function createGeometryBoard(element,initialScene,callbacks={}) {
  const JXG=globalThis.JXG;
  if(!JXG?.JSXGraph)throw new Error('几何画板未加载，请刷新页面');
  let scene=clone(initialScene),board,objects=new Map(),segmentTexts=[],lineLabels=[],typographyScale=1,tool='move',picked=[],dragging=false,dirty=false,selected=null,destroyed=false,updating=false;
  const error=message=>callbacks.onError?.(String(message));
  const status=message=>{if(element.dataset)element.dataset.status=message;callbacks.onStatus?.(message);};
  const typography=()=>{
    typographyScale=displayTypographyScale(element.clientWidth||800,element.clientHeight||600);
    element.style?.setProperty('--geometry-font-size',`${17*typographyScale}px`);
    return {fontSize:17*typographyScale,offsetUnit:typographyScale,segmentFontSize:17*typographyScale,segmentOffsetUnit:typographyScale};
  };
  const scaledOffset=offset=>offset.map(value=>value*typographyScale);
  const fittedBounds=()=>{
    // Match the viewport ratio explicitly: JSXGraph's axis-selection heuristic
    // can otherwise crop wide constructions after a switch to portrait layout.
    return fittedSceneViewport(scene,element.clientWidth||800,element.clientHeight||600,typography()).bounds;
  };
  const refreshTypography=()=>{
    const {fontSize}=typography(),{points,errors}=evaluateScene(scene);
    if(errors.length)return;
    for(const [id,object]of objects){const point=scene.points.find(item=>item.id===id);object.label?.setAttribute({fontSize,offset:scaledOffset(pointLabelOffset(scene,point,points))});}
    for(const text of segmentTexts)text.setAttribute?.({fontSize});
    for(const label of lineLabels)label.setAttribute?.({fontSize,offset:scaledOffset([-35,10])});
  };
  const select=id=>{selected=id;callbacks.onSelect?.(id);};
  const nextId=(prefix='P')=>{const ids=new Set(['points','segments','lines','circles','angles','constraints'].flatMap(k=>(scene[k]??[]).map(p=>p.id)));if(prefix==='P')for(const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')if(!ids.has(c))return c;let n=1;while(ids.has(prefix+n))n++;return prefix+n;};
  const movable=(p,seen=new Set())=>{if(seen.has(p.id))return false;seen.add(p.id);return ['free','onLine','onCircle'].includes(p.kind)||(p.kind==='rotate'&&movable(scene.points.find(s=>s.id===p.source),seen));};
  // JSXGraph is still dispatching pointer events inside handlers. Rebuilding it or
  // letting callers rebuild synchronously would invalidate its active hit list.
  const notify=()=>{const snapshot=clone(scene);queueMicrotask(()=>{if(!destroyed)callbacks.onChange?.(snapshot);});};
  const apply=next=>{const errors=validateScene(next);if(errors.length){error(errors.join('；'));return false;}scene=next;queueMicrotask(()=>render(false));notify();return true;};
  const remove=id=>{
    const removed=new Set([id]);let changed=true;
    while(changed){changed=false;for(const p of scene.points)if(!removed.has(p.id)&&refs(p).some(r=>removed.has(r))){removed.add(p.id);changed=true;}}
    const next=clone(scene);next.points=next.points.filter(p=>!removed.has(p.id));
    for(const k of ['segments','lines','circles','angles','constraints'])if(next[k])next[k]=next[k].filter(p=>!refs(p).some(r=>removed.has(r)));
    if(apply(next)){select(null);status(`已删除 ${removed.size} 个点及相关构造。`);}
  };
  const choose=id=>{
    select(id);
    if(tool==='delete'){remove(id);return;}
    if(tool==='move'||tool==='point')return;
    if(picked.includes(id)){status('请选择另一个点。');return;}
    picked.push(id);
    const required=tool==='perpendicular'?3:2;
    if(picked.length<required){status(`已选 ${picked.join('、')}；${tools[tool]}`);return;}
    const next=clone(scene),[a,b,c]=picked;
    if(tool==='segment'||tool==='line')next[tool==='segment'?'segments':'lines'].push({id:nextId(tool==='segment'?'s':'l'),from:a,to:b});
    if(tool==='circle')next.circles.push({id:nextId('c'),center:a,through:b});
    if(tool==='midpoint')next.points.push({id:nextId(),kind:'midpoint',from:a,to:b});
    if(tool==='perpendicular'){const foot=nextId();next.points.push({id:foot,kind:'project',point:a,from:b,to:c});next.segments.push({id:nextId('s'),from:a,to:foot});}
    picked=[];if(apply(next))status(`构造完成。${tools[tool]}`);
  };
  const sync=()=>{
    const {points,errors}=evaluateScene(scene);if(errors.length){error(errors.join('；'));return;}
    updating=true;board.suspendUpdate?.();
    for(const [id,obj] of objects){const p=points[id];obj.setPosition(JXG.COORDS_BY_USER,[p.x,p.y]);const model=scene.points.find(item=>item.id===id);if(model?.labelOffset===undefined)obj.label?.setAttribute({offset:scaledOffset(pointLabelOffset(scene,model,points))});}
    board.unsuspendUpdate?.();board.update();updating=false;
  };
  const commitDrag=()=>{if(!dragging)return;dragging=false;if(dirty){dirty=false;notify();}};
  const render=(fit=true)=>{
    if(destroyed)return;
    const errors=validateScene(scene);
    if(board)JXG.JSXGraph.freeBoard(board);
    objects=new Map();segmentTexts=[];lineLabels=[];
    board=JXG.JSXGraph.initBoard(element.id,{boundingbox:fittedBounds(),axis:false,grid:false,showCopyright:false,showNavigation:false,keepaspectratio:true,renderer:'svg',pan:{enabled:false},zoom:{enabled:false,wheel:false,pinch:false},keyboard:{enabled:false}});
    if(errors.length){error(errors.join('；'));return;}
    const {points}=evaluateScene(scene);
    board.suspendUpdate?.();
    for(const p of scene.points){
      const canMove=movable(p),coords=points[p.id];
      const point=board.create('point',[coords.x,coords.y],{name:p.label??p.id,visible:p.visible!==false,withLabel:p.visible!==false,size:canMove?4:3,face:'o',fixed:tool!=='move'||!canMove,strokeColor:canMove?'#2563eb':'#14856f',fillColor:canMove?'#fff':'#b5e5d8',highlightStrokeColor:'#ed8c36',showInfobox:false,label:{offset:scaledOffset(pointLabelOffset(scene,p,points)),display:'internal',parse:false,useMathJax:false,fontSize:17*typographyScale}});
      objects.set(p.id,point);
      point.on('down',()=>{choose(p.id);if(tool==='move'&&canMove){dragging=true;dirty=false;}else if(tool==='move')status(`点 ${p.id} 是${{project:'垂足',midpoint:'中点',intersection:'交点',rotate:'受约束旋转点'}[p.kind]??'依赖点'}，请拖动它的源点。`);});
      point.on('drag',()=>{
        if(updating||tool!=='move'||!dragging)return;
        try{const next=movePoint(scene,p.id,point.X(),point.Y());if(JSON.stringify(next)!==JSON.stringify(scene)){scene=next;dirty=true;}sync();}
        catch(err){error(err.message);sync();}
      });
    }
    const shared=item=>({strokeColor:'#27364b',strokeWidth:width(item,scene),highlight:false,fixed:true,visible:item.visible!==false});
    for(const item of scene.segments){
      const from=objects.get(item.from),to=objects.get(item.to);
      board.create('segment',[from,to],shared(item));
      if(item.label!==undefined&&item.label!==false){
        const offset=item.labelOffset??[0,12];
        segmentTexts.push(board.create('text',[()=> (from.X()+to.X())/2+offset[0]*typographyScale/board.unitX,()=> (from.Y()+to.Y())/2+offset[1]*typographyScale/board.unitY,String(item.label)],{fixed:true,highlight:false,visible:item.visible!==false,display:'internal',parse:false,useMathJax:false,anchorX:'middle',anchorY:'middle',fontSize:17*typographyScale,strokeColor:'#27364b'}));
      }
    }
    for(const item of scene.lines){const line=board.create('line',[objects.get(item.from),objects.get(item.to)],{...shared(item),name:item.label===false?'':item.label??item.id,withLabel:item.label!==false,label:{position:'rt',offset:scaledOffset([-35,10]),fontSize:17*typographyScale,display:'internal',parse:false}});if(line.label)lineLabels.push(line.label);}
    for(const item of scene.circles)board.create('circle',[objects.get(item.center),()=>radius(item,evaluateScene(scene).points)],shared(item));
    for(const item of scene.angles)board.create('angle',[objects.get(item.a),objects.get(item.vertex),objects.get(item.b)],{...shared(item),type:item.right?'square':'sector',orthoType:item.right?'square':'sector',radius:item.right?()=>angleRadius(item,evaluateScene(scene).points):.28,fillOpacity:0,withLabel:false});
    board.on('up',commitDrag);
    board.on('down',event=>{
      if(tool!=='point')return;
      const under=board.getAllObjectsUnderMouse?.(event)??[];
      if(under.some(o=>[...objects.values()].includes(o)))return;
      const [x,y]=board.getUsrCoordsOfMouse(event),next=clone(scene),id=nextId();next.points.push({id,kind:'free',x,y});if(apply(next))select(id);
    });
    board.unsuspendUpdate?.();if(fit)board.setBoundingBox(fittedBounds(),true);
  };
  render();status(tools.move);
  return {
    setScene(next){scene=clone(next);picked=[];dragging=false;dirty=false;render();if(selected&&!scene.points?.some(p=>p.id===selected))select(null);},
    getScene(){return clone(scene);},
    setTool(name){if(!Object.hasOwn(tools,name)){error(`未知工具：${name}`);return;}commitDrag();tool=name;picked=[];for(const p of scene.points)objects.get(p.id)?.setAttribute({fixed:name!=='move'||!movable(p)});status(tools[name]);},
    resize(){if(!destroyed){
      // The host owns its CSS dimensions. Writing measured pixels back here
      // freezes percentage/media-query widths after the first desktop resize.
      board.suspendUpdate?.();refreshTypography();
      board.resizeContainer?.(element.clientWidth||800,element.clientHeight||600,true,true);
      board.setBoundingBox(fittedBounds(),true);
      board.unsuspendUpdate?.();board.update?.();
    }},
    destroy(){if(!destroyed){destroyed=true;JXG.JSXGraph.freeBoard(board);objects.clear();}},
    exportSvg(){return exportSceneSvg(scene);},
    selectPoint(id){if(id!==null&&!scene.points.some(p=>p.id===id)){error(`找不到点 ${id}`);return;}select(id);}
  };
}

