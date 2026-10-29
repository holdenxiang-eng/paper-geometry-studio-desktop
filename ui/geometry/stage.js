import {createGeometryBoard,exportSceneSvg,displayTypographyScale} from './board.js';
import {figureLayout,figureStageSize,figureInsets} from './layout.js';

let stageSequence=0;
const clone=value=>structuredClone(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const caption=figure=>{const name=typeof figure.name==='string'?figure.name.trim():'';return /^(?:题图|提图)$/.test(name)?'':name;};

export function createFigureStage(element,callbacks={}){
  const stageId=++stageSequence,records=new Map();
  let activeId=null,live=null,tool='move',locked=false,destroyed=false,queued=false,gesture=null,generation=0,scale=1,order=[];
  const plane=document.createElement('div');plane.className='figure-stage-plane';
  Object.assign(plane.style,{position:'relative',width:'100%',minHeight:'1px'});
  element.replaceChildren(plane);element.classList.add('figure-stage-host');
  const error=message=>callbacks.onError?.(String(message));
  const effective=record=>gesture?.id===record.figure.id?gesture.current:record.layout;
  const stopLive=()=>{if(live){live.controller.destroy();live=null;generation++;}};
  const schedule=()=>{if(!queued&&!destroyed){queued=true;queueMicrotask(()=>{queued=false;if(!destroyed)render();});}};
  const choose=id=>{
    if(activeId===id)return;
    activeId=id;callbacks.onPointSelect?.(null);schedule();callbacks.onSelect?.(id);
  };
  const preview=record=>{
    const width=Math.max(1,record.canvas.clientWidth),height=Math.max(1,record.canvas.clientHeight),key=`${record.signature}/${width}/${height}`;
    if(record.previewKey===key&&record.canvas.querySelector('svg'))return;
    try{record.canvas.innerHTML=exportSceneSvg(record.figure.scene,{width,height,fontSize:17*displayTypographyScale(width,height),strokeScale:1});const svg=record.canvas.querySelector('svg');Object.assign(svg.style,{width:'100%',height:'100%',display:'block'});record.previewKey=key;}
    catch(err){record.canvas.textContent=err.message;record.previewKey=null;error(err.message);}
  };
  const position=()=>{
    scale=(element.clientWidth||1000)/1000;
    const size=figureStageSize(order.map(id=>{const r=records.get(id);return {...r.figure,layout:effective(r)};}));
    plane.style.height=`${size.height*scale}px`;
    for(const id of order){const record=records.get(id),l=effective(record),inset=figureInsets(record.figure);Object.assign(record.frame.style,{left:`${l.x*scale}px`,top:`${l.y*scale}px`,width:`${l.width*scale}px`,height:`${l.height*scale}px`});Object.assign(record.canvas.style,{left:`${inset.left}px`,right:`${inset.right}px`,top:`${inset.top}px`,bottom:`${inset.bottom}px`});Object.assign(record.header.style,{top:inset.captionBottom?'auto':'0',bottom:inset.captionBottom?'0':'auto'});record.frame.classList.toggle('caption-bottom',inset.captionBottom);}
    if(live)live.controller.resize();
  };
  const begin=(event,id,mode)=>{
    if(event.button!==undefined&&event.button!==0)return;
    choose(id);if(locked)return;
    event.preventDefault();event.stopPropagation();
    const record=records.get(id),target=event.currentTarget;
    gesture={id,mode,startX:event.clientX,startY:event.clientY,scale,original:clone(record.layout),current:clone(record.layout),target,pointerId:event.pointerId};
    target.setPointerCapture?.(event.pointerId);record.frame.classList.add('layout-dragging');
  };
  const move=event=>{
    if(!gesture||locked||event.pointerId!==gesture.pointerId)return;
    event.preventDefault();const g=gesture,dx=(event.clientX-g.startX)/g.scale,dy=(event.clientY-g.startY)/g.scale,l=g.original;
    g.current=g.mode==='move'?{...l,x:clamp(l.x+dx,0,1000-l.width),y:clamp(l.y+dy,0,5000-l.height)}:{...l,width:clamp(l.width+dx,160,1000-l.x),height:clamp(l.height+dy,140,5000-l.y)};
    position();
  };
  const end=(event,cancel=false)=>{
    if(!gesture||event&&event.pointerId!==gesture.pointerId)return;
    const g=gesture,record=records.get(g.id);gesture=null;
    try{if(g.target.hasPointerCapture?.(g.pointerId))g.target.releasePointerCapture(g.pointerId);}catch{/* detached pointer target */}
    record?.frame.classList.remove('layout-dragging');
    if(record&&!cancel&&!locked&&!same(g.original,g.current)){
      record.layout=clone(g.current);record.figure.layout=clone(g.current);const snapshot=clone(g.current);
      queueMicrotask(()=>{if(!destroyed)callbacks.onLayoutChange?.(g.id,snapshot);});
    }
    position();if(record&&(!live||live.id!==g.id))preview(record);
  };
  const makeFrame=figure=>{
    const frame=document.createElement('section'),header=document.createElement('div'),canvas=document.createElement('div'),handle=document.createElement('button');
    frame.className='figure-frame';frame.dataset.figureId=figure.id;
    Object.assign(frame.style,{position:'absolute',boxSizing:'border-box',border:'1px solid #d4dfd0',borderRadius:'5px',background:'#fff',overflow:'visible'});
    header.className='figure-frame-header';header.textContent=caption(figure);header.title='拖动此区域移动整图';
    Object.assign(header.style,{position:'absolute',zIndex:'2',left:'0',right:'0',top:'0',height:'24px',boxSizing:'border-box',padding:'3px 8px',font:'12px sans-serif',background:'#f4f7f0',cursor:'grab',touchAction:'none',userSelect:'none'});
    canvas.className='figure-frame-canvas';canvas.id=`figure-canvas-${stageId}-${++generation}`;
    Object.assign(canvas.style,{position:'absolute',zIndex:'1',left:'6px',right:'6px',top:'25px',bottom:'7px',touchAction:'none'});
    handle.className='figure-resize-handle';handle.type='button';handle.title='拖动缩放整图';
    Object.assign(handle.style,{position:'absolute',zIndex:'3',right:'0',bottom:'0',width:'18px',height:'18px',border:'0',padding:'0',background:'linear-gradient(135deg,transparent 50%,#9cb193 51%,#9cb193 61%,transparent 62%,transparent 72%,#9cb193 73%,#9cb193 83%,transparent 84%)',cursor:'nwse-resize',touchAction:'none'});
    header.addEventListener('pointerdown',event=>begin(event,figure.id,'move'));handle.addEventListener('pointerdown',event=>begin(event,figure.id,'resize'));
    for(const node of [header,handle]){node.addEventListener('pointermove',move);node.addEventListener('pointerup',event=>end(event));node.addEventListener('pointercancel',event=>end(event,true));}
    canvas.addEventListener('pointerdown',()=>choose(figure.id));
    frame.append(header,canvas,handle);plane.append(frame);
    return {figure:clone(figure),layout:null,signature:'',previewKey:null,frame,header,canvas,handle};
  };
  function render(){
    for(const [id,record]of records)if(!order.includes(id)){if(live?.id===id)stopLive();record.frame.remove();records.delete(id);}
    if(live&&(locked||live.id!==activeId||!records.has(live.id))){const previous=records.get(live.id);stopLive();if(previous){previous.canvas.replaceChildren();previous.previewKey=null;}}
    position();
    for(const id of order){
      const record=records.get(id),selected=id===activeId;
      record.frame.classList.toggle('active',selected);record.frame.classList.toggle('locked',locked);record.frame.style.borderColor=selected?'#649259':'#d4dfd0';record.frame.style.zIndex=selected?'2':'1';
      const text=caption(record.figure),controlName=text||`第${order.indexOf(id)+1}幅图`;
      record.frame.classList.toggle('has-caption',Boolean(text));
      record.frame.setAttribute('aria-label',controlName);record.header.setAttribute('aria-label',`${controlName}：移动`);record.handle.setAttribute('aria-label',`${controlName}：缩放`);
      record.header.textContent=text;record.header.style.cursor=locked?'default':'grab';record.handle.disabled=locked;record.handle.hidden=locked;
      if(selected&&!locked){
        if(!live){
          record.canvas.replaceChildren();record.previewKey=null;const token=++generation;
          try{
            const controller=createGeometryBoard(record.canvas,record.figure.scene,{
              onChange:scene=>{
                if(destroyed||locked||live?.token!==token)return;
                const current=records.get(id);if(!current)return;current.figure.scene=clone(scene);current.signature=JSON.stringify(scene);live.signature=current.signature;
                callbacks.onSceneChange?.(id,clone(scene));
              },
              onSelect:pointId=>{if(!locked&&live?.token===token)callbacks.onPointSelect?.(pointId);},
              onStatus:message=>callbacks.onStatus?.(message),onError:error
            });
            live={id,token,controller,signature:record.signature};controller.setTool(tool);
          }catch(err){error(err.message);preview(record);}
        }else if(live.signature!==record.signature){live.controller.setScene(record.figure.scene);live.signature=record.signature;}
      }else preview(record);
    }
  }
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(!destroyed)api.resize();}):null;
  const api={
    setFigures(figures,selectedId=activeId){
      if(destroyed)return;
      try{
        if(!Array.isArray(figures))throw new Error('题图列表无效');
        const ids=new Set();const prepared=figures.map((figure,index)=>{if(!figure||typeof figure.id!=='string'||!figure.id||ids.has(figure.id))throw new Error('题图 ID 必须非空且唯一');ids.add(figure.id);return {figure:clone(figure),layout:figureLayout(figure,index,figures.length),signature:JSON.stringify(figure.scene)};});
        if(gesture)end(null,true);
        order=prepared.map(p=>p.figure.id);
        for(const item of prepared){let record=records.get(item.figure.id);if(!record){record=makeFrame(item.figure);records.set(item.figure.id,record);}record.figure=item.figure;record.layout=item.layout;record.signature=item.signature;}
        activeId=selectedId===null?null:ids.has(selectedId)?selectedId:order[0]??null;
        schedule();
      }catch(err){error(err.message);}
    },
    setTool(name){tool=name;if(!locked)live?.controller.setTool(name);},
    selectPoint(id){if(!locked)live?.controller.selectPoint(id);},
    resize(){if(destroyed)return;position();for(const id of order){const record=records.get(id);if(live?.id!==id)preview(record);}},
    setLocked(value){if(destroyed||locked===Boolean(value))return;locked=Boolean(value);if(gesture)end(null,true);callbacks.onPointSelect?.(null);schedule();},
    destroy(){if(destroyed)return;destroyed=true;if(gesture)end(null,true);observer?.disconnect();stopLive();records.clear();plane.remove();element.classList.remove('figure-stage-host');}
  };
  observer?.observe(element);return api;
}

