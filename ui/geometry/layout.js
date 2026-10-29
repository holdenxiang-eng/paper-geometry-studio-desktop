const finite=value=>typeof value==='number'&&Number.isFinite(value);

export function defaultFigureLayout(index,total){
  if(!Number.isInteger(index)||index<0||!Number.isInteger(total)||total<1||index>=total)throw new Error('布局索引无效');
  const columns=total===1?1:2,width=columns===1?960:470,height=320;
  return {x:20+(index%columns)*(width+20),y:20+Math.floor(index/columns)*(height+20),width,height};
}

export function figureLayout(figure,index,total){
  const value=figure?.layout===undefined?defaultFigureLayout(index,total):figure.layout;
  if(!value||typeof value!=='object'||!['x','y','width','height'].every(key=>finite(value[key]))||value.x<0||value.y<0||value.width<160||value.height<140||value.x+value.width>1000||value.y+value.height>5000)throw new Error('图形布局无效：位置或尺寸超出纸面范围');
  return {x:value.x,y:value.y,width:value.width,height:value.height};
}

export function figureStageSize(figures){
  if(!Array.isArray(figures))throw new Error('图形布局列表无效');
  const bottoms=figures.map((figure,index)=>{const l=figureLayout(figure,index,figures.length);return l.y+l.height;});
  return {width:1000,height:figures.length?Math.max(...bottoms):360};
}

// Screen and export share the same normalized frame chrome. An empty move
// handle stays below the drawing, without an empty title above its vertices.
export function figureInsets(figure){
  const name=typeof figure?.name==='string'?figure.name.trim():'';
  const named=Boolean(name&&!/^(?:题图|提图)$/.test(name));
  const bottom=figure.captionPosition!=='top';
  return {left:0,right:0,top:named&&!bottom?24:0,bottom:named&&bottom?24:0,captionBottom:bottom};
}

