
(function(){
var doc=document,root=doc.documentElement,figs=[],cleanups=[];
function css(n,f){var v=getComputedStyle(root).getPropertyValue(n).trim();return v||f}
function pal(){var p=[];for(var i=1;i<=8;i++)p.push(css('--ac-c'+i,'#888'));return p}
function lum(hex){var m=/^#?([0-9a-f]{6})$/i.exec(hex||'');if(!m)return .5;var n=parseInt(m[1],16),r=n>>16&255,g=n>>8&255,b=n&255;
 function c(x){x/=255;return x<=.03928?x/12.92:Math.pow((x+.055)/1.055,2.4)}return .2126*c(r)+.7152*c(g)+.0722*c(b)}
function alpha(hex,a){var m=/^#?([0-9a-f]{6})$/i.exec(hex||'');if(!m)return hex;var n=parseInt(m[1],16);return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')'}
function mkfmt(f,compact){f=f||{};var o={},k;for(k in (f.options||{}))o[k]=f.options[k];
 if(compact){o.notation='compact';o.maximumFractionDigits=1;delete o.minimumFractionDigits}
 var nf;try{nf=new Intl.NumberFormat(f.locale||undefined,o)}catch(e){nf=new Intl.NumberFormat(undefined)}
 var u=f.unit?' '+f.unit:'';return function(v){return v==null||isNaN(v)?'':nf.format(v)+u}}
var pcts={};function pct(x,l){var k=l||'';if(!pcts[k]){try{pcts[k]=new Intl.NumberFormat(l||undefined,{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1})}catch(e){pcts[k]=new Intl.NumberFormat(undefined,{style:'percent'})}}return pcts[k].format(x)}
function short(s,n){s=String(s);return s.length>n?s.slice(0,n-1)+'…':s}
function labelsPlugin(spec,fmt,ink){return{id:'acLabels',afterDatasetsDraw:function(chart){
 var ctx=chart.ctx,type=spec.kind;ctx.save();ctx.font='600 12px '+Chart.defaults.font.family;ctx.textBaseline='middle';
 chart.data.datasets.forEach(function(ds,i){var meta=chart.getDatasetMeta(i);if(meta.hidden)return;
  meta.data.forEach(function(el,j){if(el.hidden)return;var v=ds.data[j];if(v==null)return;
   if(type==='pie'||type==='donut'){var p=spec.percents[j];if(p<6)return;var pos=el.tooltipPosition();
    ctx.fillStyle=lum(ds.backgroundColor[j])>.42?'#111':'#fff';ctx.textAlign='center';ctx.fillText(pct(p/100,spec.fmt.locale),pos.x,pos.y);return}
   if(!spec.valueLabels||spec.stacked)return;ctx.fillStyle=ink;
   if(type==='hbar'){ctx.textAlign=v>=0?'left':'right';ctx.fillText(fmt(v),el.x+(v>=0?5:-5),el.y)}
   else if(type==='bar'){ctx.textAlign='center';ctx.fillText(fmt(v),el.x,el.y+(v>=0?-9:9))}})});ctx.restore()}}}
function build(fig){
 var spec=JSON.parse(fig.querySelector('script[type="application/json"]').textContent);
 var canvas=fig.querySelector('canvas'),colors=pal(),ink=css('--ac-text','#111'),muted=css('--ac-muted','#555'),grid=css('--ac-grid','#ddd'),surface=css('--ac-surface','#fff');
 var fmt=mkfmt(spec.fmt),axisFmt=mkfmt(spec.fmt,true),lblFmt=spec.series.length>1?axisFmt:fmt,kind=spec.kind,pie=kind==='pie'||kind==='donut';
 var cfg={options:{responsive:true,maintainAspectRatio:false,animation:{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:250},
  layout:{padding:{top:kind==='bar'&&spec.valueLabels?14:2,right:kind==='hbar'?40:4}},
  plugins:{legend:{display:pie||spec.series.length>1,position:'bottom',labels:{color:ink,usePointStyle:true,pointStyle:'rectRounded',boxWidth:10,boxHeight:10,padding:14}},
   tooltip:{callbacks:{}}}},plugins:[labelsPlugin(spec,lblFmt,ink)]};
 var o=cfg.options,i;
 Chart.defaults.color=muted;Chart.defaults.font.family='system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';Chart.defaults.font.size=12.5;
 if(pie){var d=spec.series[0].data,bg=d.map(function(_,j){return spec.otherLast&&j===d.length-1?css('--ac-other','#8a8f98'):colors[j%8]});
  cfg.type=kind==='donut'?'doughnut':'pie';cfg.data={labels:spec.labels,datasets:[{data:d,backgroundColor:bg,borderColor:surface,borderWidth:2,hoverOffset:6}]};
  if(kind==='donut')o.cutout='58%';
  o.plugins.legend.labels.generateLabels=function(chart){var base=Chart.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
   base.forEach(function(it,j){it.text=short(it.text,28)+' · '+pct(spec.percents[j]/100,spec.fmt.locale);it.fontColor=ink;it.strokeStyle=surface;it.lineWidth=0});return base};
  o.plugins.tooltip.callbacks.label=function(c){return ' '+c.label+': '+fmt(c.parsed)+' ('+pct(spec.percents[c.dataIndex]/100,spec.fmt.locale)+')'};
  if(kind==='donut'&&spec.center){cfg.plugins.push({id:'acCenter',afterDraw:function(ch){var a=ch.chartArea,c=ch.ctx;c.save();c.fillStyle=ink;c.textAlign='center';c.textBaseline='middle';
   c.font='700 18px '+Chart.defaults.font.family;c.fillText(spec.center,(a.left+a.right)/2,(a.top+a.bottom)/2);c.restore()}})}
 }else{
  var horiz=kind==='hbar',xy=kind==='scatter';
  cfg.type=kind==='hbar'?'bar':kind==='area'?'line':kind;
  cfg.data={labels:spec.labels,datasets:spec.series.map(function(s,j){var c=colors[j%8],ds={label:s.name||'',data:s.data,backgroundColor:c,borderColor:c};
   if(kind==='bar'||kind==='hbar'){ds.borderRadius=4;ds.maxBarThickness=56;ds.borderSkipped=false}
   if(kind==='line'||kind==='area'){ds.borderWidth=2;ds.tension=spec.smooth?.3:0;ds.pointRadius=spec.labels.length>30?0:3;ds.pointHoverRadius=5;ds.pointBackgroundColor=c;ds.pointBorderColor=surface;ds.pointBorderWidth=1.5;ds.spanGaps=false;
    if(kind==='area'){ds.fill=spec.stacked?(j===0?'origin':'-1'):'origin';ds.backgroundColor=alpha(c,.2)}}
   if(xy){ds.pointRadius=4;ds.pointHoverRadius=6;ds.pointBackgroundColor=alpha(c,.8);ds.pointBorderColor=c}
   return ds})};
  if(horiz)o.indexAxis='y';
  var cat={grid:{display:false},border:{color:grid},ticks:{color:muted,autoSkip:true,maxRotation:horiz?0:45,callback:function(v){var w=this.chart.width;return short(this.getLabelForValue(v),horiz?(w<420?15:24):(w<420?10:18))}}};
  var val={beginAtZero:kind!=='line'&&!xy,stacked:!!spec.stacked,grace:spec.valueLabels&&!spec.stacked?'8%':0,grid:{color:grid},border:{display:false},ticks:{color:muted,callback:function(v){return axisFmt(v)}}};
  if(xy){cat={type:'linear',grid:{color:grid},border:{color:grid},ticks:{color:muted,callback:function(v){return axisFmt(v)}}};val.beginAtZero=false}
  if(spec.xTitle)cat.title={display:true,text:spec.xTitle,color:muted};if(spec.yTitle)val.title={display:true,text:spec.yTitle,color:muted};
  if(spec.stacked)cat.stacked=true;
  o.scales=horiz?{y:cat,x:val}:{x:cat,y:val};
  if(kind==='line'||kind==='area'){o.interaction={mode:'index',intersect:false}}
  else if(kind==='bar'||kind==='hbar')o.interaction={mode:'index',intersect:false};
  if(horiz)o.interaction.axis='y';
  o.plugins.tooltip.callbacks.label=function(c){var v=horiz?c.parsed.x:xy?c.parsed.y:c.parsed.y,n=c.dataset.label?c.dataset.label+': ':'';
   return ' '+n+(xy?fmt(c.parsed.x)+', ':'')+fmt(v)};
  if(xy)o.plugins.tooltip.callbacks.title=function(){return ''};
 }
 if(fig._chart)fig._chart.destroy();
 fig._chart=new Chart(canvas,cfg);
}
function tables(){doc.querySelectorAll('figure[data-ac-chart] td[data-v]').forEach(function(td){
 var f=td.closest('figure'),spec=f._spec||(f._spec=JSON.parse(f.querySelector('script[type="application/json"]').textContent)),
  n=parseFloat(td.getAttribute('data-v'));if(!isNaN(n))td.textContent=mkfmt(spec.fmt)(n)})}
function draw(){doc.querySelectorAll('figure[data-ac-chart]').forEach(function(fig){
 try{build(fig);fig.classList.remove('ac-pending');var d=fig.querySelector('details');if(d&&!fig._opened){d.removeAttribute('open');fig._opened=1}}
 catch(e){fig.classList.add('ac-pending');if(window.console)console.error('alisio chart failed',e)}})}
function start(){if(typeof Chart==='undefined'){return}tables();draw();
 try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',draw)}catch(e){}}
if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start);else start();
})();
