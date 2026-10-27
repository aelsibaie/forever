from pathlib import Path
import sys, json, math, html, platform
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Patch
from matplotlib.ticker import FuncFormatter, MaxNLocator

R=Path(sys.argv[1]).resolve()
read=lambda name:json.loads((R/name).read_text(encoding='utf-8-sig'))
A=read('analysis.json');P=read('provenance.json');CAT=read('profiles.json');CELLS=read('cells.json')
C=R/'charts';C.mkdir(exist_ok=True)
BG='#0b1220';TEXT='#edf3fc';MUTED='#a1afc5';GRID='#25344b'
RACES={'RaceHuman':'Human','RaceDwarf':'Dwarf','RaceNightElf':'Night Elf','RaceGnome':'Gnome','RaceHighOrderSkyborne':'High Order','RaceOrc':'Orc','RaceTroll':'Troll','RaceUndead':'Undead','RaceTauren':'Tauren','RaceWindshaperSkyborne':'Windshaper'}
COLORS=dict(zip(RACES,['#dfa970','#e1c96c','#bf9ded','#62d0bd','#77baff','#86c86d','#56cfc1','#c3a1f0','#dea86e','#70baff']))
CC={'Mage':'#77cfff','Rogue':'#f3d473','Warlock':'#b99af4','Warrior':'#d6aa83','Hunter':'#9bd176','Priest':'#d9e0eb','Druid':'#ff9d5c','Shaman':'#5ba6ff','Paladin':'#efa5c6'}
CLASSES=list(CC)
PROFILES={(p['faction'],p['id']):p for p in CAT['profiles']}
CONF={(p['faction'],p['profileId']):p for p in A['confidence']}
GROUP={(g['faction'],g['profileId'],g['duration']):g for g in A['primary']}
DURATIONS=A['settings']['durations']
META=f"WoWSims {P['snapshot']['commit'][:10]} | model {P['model']['name']} | {A['settings']['iterations']:,} iterations/cell | seed {A['settings']['seed']}"
plt.rcParams.update({'font.family':'DejaVu Sans','figure.facecolor':BG,'axes.facecolor':BG,'axes.edgecolor':GRID,'axes.labelcolor':MUTED,'xtick.color':MUTED,'ytick.color':TEXT,'text.color':TEXT,'savefig.facecolor':BG,'font.size':10})

arrays={}
def values(row):
 if row['key'] not in arrays:arrays[row['key']]=np.array(read('results/'+row['key']+'.json')['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'])
 return arrays[row['key']]
failures=[];max_mean=0.;max_ci=0.;audited=0
for g in A['primary']+A['baseline']+A['confirmations']+A['sensitivity']:
 ref=next(r for r in g['rows'] if r['race']==g['referenceRace']);y=values(ref)
 for row in g['rows']:
  x=values(row);err=abs(float(x.mean())-row['meanDps']);max_mean=max(max_mean,err)
  mean_half=1.959963984540054*float(np.std(x,ddof=1))/math.sqrt(len(x))
  ratio=float(x.mean()/y.mean());cov=np.cov(np.stack([x,y]),ddof=1);variance=max(0.,float(cov[0,0]+ratio*ratio*cov[1,1]-2*ratio*cov[0,1]));half=100*1.959963984540054*math.sqrt(variance/len(x))/float(y.mean());pair_err=abs(half-row['vsReference']['ci95HalfWidthPercent']);max_ci=max(max_ci,pair_err)
  if err>1e-8 or abs(mean_half-row['ci95HalfWidth'])>1e-8 or pair_err>1e-6:failures.append(row['key'])
  audited+=1
(R/'numerical-review.json').write_text(json.dumps({'auditedGroupedCells':audited,'failures':failures,'maximumMeanErrorDps':max_mean,'maximumPairedCiErrorPercentagePoints':max_ci,'method':'Independent NumPy mean, variance and covariance calculation. Sampling checks do not validate mechanics.'},indent=2))
if failures:raise RuntimeError('Independent numerical verification failed: '+str(failures[:5]))
arrays.clear()

def label(faction,pid,include_class=True):
 p=PROFILES[faction,pid]
 name=p['name']
 if include_class:name=p['specLabel']+' · '+name
 elif name in ['Testing','Default'] or p['className'] in ['Druid','Shaman']:name=p['specLabel'].replace(' '+p['className'],'')+' · '+name
 return name+(' †' if CONF[faction,pid]['markers'] else '')

def map_chart(faction,profiles,filename,scenario=None):
 columns=[str(t)+' seconds' for t in DURATIONS] if scenario is None else ['Neutral','Beast','Elemental']
 h=3.8+len(profiles)*.46;fig,ax=plt.subplots(figsize=(12,h));fig.subplots_adjust(left=.32,right=.96,top=1-2/h,bottom=1.5/h)
 fig.text(.045,1-.38/h,'WOWSIMS FOREVER / RACIAL DPS COMPARISON',fontsize=10,color=MUTED,weight='bold')
 fig.text(.045,1-.88/h,faction.title()+(': damage by fight length' if scenario is None else ': enemy type matters'),fontsize=22,weight='bold')
 fig.text(.045,1-1.27/h,('Experimental notes scenario' if P['model']['experimental'] else 'Upstream mechanics')+' · developer equipment · same build within each comparison',fontsize=9.5,color='#e2c489')
 ax.set_xlim(-.52,len(columns)-.48);ax.set_ylim(len(profiles)-.5,-.5);ax.set_xticks(range(len(columns)),columns);ax.xaxis.tick_top();ax.tick_params(axis='x',length=0,pad=13,labelsize=12);ax.set_yticks(range(len(profiles)),[label(faction,p) for p in profiles]);ax.tick_params(axis='y',length=0,pad=13,labelsize=9.5)
 for spine in ax.spines.values():spine.set_visible(False)
 for i,pid in enumerate(profiles):
  ax.get_yticklabels()[i].set_color(CC[PROFILES[faction,pid]['className']])
  for j in range(len(columns)):
   if scenario is None:g=GROUP[faction,pid,DURATIONS[j]]
   elif j==0:g=GROUP[faction,pid,scenario]
   else:g=next((g for g in A['sensitivity'] if g['faction']==faction and g['profileId']==pid and g['scenario']==['','beast','elemental'][j]),None)
   if g is None:ax.text(j,i,'Not tested',ha='center',color=MUTED,fontsize=9);continue
   lead=g['leadOverSecond'];color='#cbb58b' if g['rankingWithheld'] else '#b5bdca' if g['practicalTie'] else COLORS[g['winner']]
   title='No verdict' if g['rankingWithheld'] else RACES[g['winner']]+(' only' if g['onlyChoice'] else ' ~' if g['practicalTie'] else '')
   subtitle='Racial still unused' if g['rankingWithheld'] else 'No faction alternative' if g['onlyChoice'] else f"+{lead['percent']:.2f}% vs next"
   ax.add_patch(FancyBboxPatch((j-.46,i-.39),.92,.78,boxstyle='round,pad=.015,rounding_size=.055',facecolor=color+'26',edgecolor=color+'77',lw=.8));ax.text(j,i-.075,title,ha='center',va='center',fontsize=11,weight='bold',color=color);ax.text(j,i+.19,subtitle,ha='center',va='center',fontsize=8.8,color=MUTED)
  if i+1<len(profiles) and PROFILES[faction,profiles[i+1]]['className']!=PROFILES[faction,pid]['className']:ax.axhline(i+.5,color=GRID,lw=1)
 fig.text(.045,1.12/h,'Single level-63 target; fixed gear and talents. Labels show the highest mean and its lead over the next race.',fontsize=8.5,color=MUTED)
 fig.text(.045,.83/h,'~ = close race comparison. † = preset caveat or explicit racial activation adjustment; see report for details.',fontsize=8.5,color=MUTED)
 fig.text(.045,.52/h,'Unsupported exported presets are listed in the report. Utility, healing and survival are outside this damage objective.',fontsize=8.2,color=MUTED)
 fig.text(.045,.18/h,META,fontsize=7.6,color=MUTED)
 fig.savefig(C/(filename+'.png'),dpi=165);fig.savefig(C/(filename+'.svg'));plt.close(fig)

factions=list(dict.fromkeys(p['faction'] for p in CAT['profiles']))
for faction in factions:
 order=[p['id'] for cls in CLASSES for p in CAT['profiles'] if p['faction']==faction and p['className']==cls]
 map_chart(faction,order,faction+'-overview')
 if A['sensitivity']:
  t=next(g['duration'] for g in A['sensitivity'] if g['faction']==faction)
  map_chart(faction,order,faction+'-target-types',t)
 for cls in CLASSES:
  profiles=[pid for pid in order if PROFILES[faction,pid]['className']==cls]
  if not profiles:continue
  races=PROFILES[faction,profiles[0]]['races'];reference=GROUP[faction,profiles[0],DURATIONS[0]]['referenceRace'];height=max(5.4,3.3+len(profiles)*.62)
  fig,axes=plt.subplots(1,len(DURATIONS),figsize=(16,height),sharey=True,squeeze=False);fig.subplots_adjust(left=.23,right=.97,top=1-1.8/height,bottom=1.4/height,wspace=.12)
  fig.text(.035,1-.4/height,faction.upper()+' / '+cls.upper(),fontsize=12,color=CC[cls],weight='bold');fig.text(.035,1-.86/height,'Damage difference with the same gear and build',fontsize=20,weight='bold');fig.text(.035,1-1.25/height,f"Bars vs {RACES[reference]}; paired 95% sampling intervals. Explicit racial adjustments are marked †.",fontsize=10,color=MUTED)
  data=[row['vsReference'] for pid in profiles for t in DURATIONS for row in GROUP[faction,pid,t]['rows']];lo=min(-.5,math.floor(min(d['percent']-d['ci95HalfWidthPercent'] for d in data)*2)/2-.2);hi=max(.5,math.ceil(max(d['percent']+d['ci95HalfWidthPercent'] for d in data)*2)/2+.2);width=.65/len(races)
  for ax,t in zip(axes[0],DURATIONS):
   ax.set_title(str(t)+' seconds',color=TEXT,pad=15)
   for ri,race in enumerate(races):
    rows=[next(r for r in GROUP[faction,pid,t]['rows'] if r['race']==race) for pid in profiles];y=np.arange(len(profiles))+(ri-(len(races)-1)/2)*width;x=[r['vsReference']['percent'] for r in rows];err=[r['vsReference']['ci95HalfWidthPercent'] for r in rows];ax.barh(y,x,height=width*.85,color=COLORS[race],alpha=.9);ax.errorbar(x,y,xerr=err,fmt='o',ms=2,capsize=1.5,lw=.7,color=COLORS[race])
   ax.axvline(0,color=MUTED,lw=.8);ax.set_xlim(lo,hi);ax.xaxis.set_major_locator(MaxNLocator(4));ax.xaxis.set_major_formatter(FuncFormatter(lambda v,pos:'0' if abs(v)<1e-8 else f'{v:+g}%'));ax.set_yticks(range(len(profiles)),[label(faction,pid,False) for pid in profiles]);ax.tick_params(axis='y',length=0,pad=10);ax.grid(axis='x',color=GRID,alpha=.6);ax.set_axisbelow(True)
   for spine in ax.spines.values():spine.set_visible(False)
  axes[0,0].invert_yaxis();fig.legend(handles=[Patch(facecolor=COLORS[r],label=RACES[r]) for r in races],loc='lower center',bbox_to_anchor=(.6,.4/height),ncol=len(races),frameon=False,labelcolor=TEXT)
  fig.text(.035,.9/height,'† = developer Testing/placeholder gear, measured mana waits, APL warnings, specialized setup or racial action added.',fontsize=8,color=MUTED);fig.text(.035,.16/height,META,fontsize=7.7,color=MUTED)
  fig.savefig(C/(faction+'-'+cls.lower()+'.png'),dpi=160);fig.savefig(C/(faction+'-'+cls.lower()+'.svg'));plt.close(fig)

e=html.escape
badges=lambda f,p:''.join('<span class="badge" title="'+e(m['reason'],quote=True)+'">'+e(m['label'])+'</span>' for m in CONF[f,p]['markers'])
def pick(g):
 if g['rankingWithheld']:return '<b class="muted">Ranking withheld</b>'
 if g['onlyChoice']:return '<b>'+RACES[g['winner']]+' only</b><small>No faction alternative</small>'
 text=RACES[g['winner']]+(' ≈ '+RACES[g['rows'][1]['race']] if g['practicalTie'] else '')
 return '<b style="color:'+('#b5bdca' if g['practicalTie'] else COLORS[g['winner']])+'">'+text+'</b><small>+'+f"{g['leadOverSecond']['percent']:.2f}% vs next · ±{g['leadOverSecond']['ci95HalfWidthPercent']:.2f} pp"+'</small>'
sections=[]
for faction in factions:
 rows=[]
 for cls in CLASSES:
  ids=[p['id'] for p in CAT['profiles'] if p['faction']==faction and p['className']==cls]
  if not ids:continue
  rows.append('<tr class="group"><th colspan="'+str(len(DURATIONS)+2)+'" style="color:'+CC[cls]+'">'+cls+'</th></tr>')
  for pid in ids:rows.append('<tr><td>'+e(PROFILES[faction,pid]['name'])+'<small>'+e(PROFILES[faction,pid]['specLabel'])+' · '+e(PROFILES[faction,pid]['gearTier'])+'</small></td>'+''.join('<td>'+pick(GROUP[faction,pid,t])+'</td>' for t in DURATIONS)+'<td>'+badges(faction,pid)+'</td></tr>')
 table='<div class="scroll"><table class="picks"><thead><tr><th>Developer preset</th>'+''.join('<th>'+str(t)+' seconds</th>' for t in DURATIONS)+'<th>Preset caveats</th></tr></thead><tbody>'+''.join(rows)+'</tbody></table></div>'
 sections.append('<section id="'+faction+'"><h2>'+faction.title()+'</h2><p>Each row compares legal races with identical equipment, talents and effective rotation. A close result names the two leading primary races. Exact-input aliases are hidden.</p><a href="charts/'+faction+'-overview.png"><img src="charts/'+faction+'-overview.png" alt="'+faction+' racial leaders by fight length"></a>'+table+'</section>')
 adjusted=[]
 for g in A['primary']:
  if g['faction']!=faction or g['scenario']!='racial-activation':continue
  base=next(b for b in A['baseline'] if b['faction']==faction and b['profileId']==g['profileId'] and b['duration']==g['duration'])
  for row in g['rows']:
   before=next(r for r in base['rows'] if r['race']==row['race']);adjusted.append('<tr>'+''.join('<td>'+e(str(v))+'</td>' for v in [g['buildName'],str(g['duration'])+'s',RACES[row['race']],f"{before['meanDps']:.2f}",f"{row['meanDps']:.2f}",f"{100*(row['meanDps']/before['meanDps']-1):+.3f}%",f"{before['racial']['casts'] or 0:.3f} → {row['racial']['casts'] or 0:.3f}"])+'</tr>')
 if adjusted:sections.append('<section><h2>'+faction.title()+': racial activation checks</h2><p>The untouched developer APL left an offensive racial unused at every duration. The adjusted comparison prepends spell-is-known guarded casts for only those missing racial IDs, identically for every race. Equipment and all original priority entries remain fixed. No other cooldown actions are inserted; their scheduling rules remain unchanged. This is a controlled adjustment, not a claim of an optimal racial rotation. Unaffected races must reproduce every original damage iteration.</p><details open><summary>Original versus adjusted DPS and racial casts per iteration</summary><div class="scroll"><table><thead><tr><th>Build</th><th>Fight</th><th>Race</th><th>Original DPS</th><th>Adjusted DPS</th><th>Change</th><th>Racial casts</th></tr></thead><tbody>'+''.join(adjusted)+'</tbody></table></div></details></section>')
 if A['sensitivity']:sections.append('<section><h2>'+faction.title()+': enemy-type sensitivity</h2><p>Only enemy type changes, using the same effective rotation. These results apply at '+str(next(g['duration'] for g in A['sensitivity'] if g['faction']==faction))+' seconds.</p><img loading="lazy" src="charts/'+faction+'-target-types.png" alt="'+faction+' enemy-type sensitivity"></section>')
 for cls in CLASSES:
  groups=[g for g in A['primary'] if g['faction']==faction and g['className']==cls]
  if not groups:continue
  detail=[]
  for g in groups:
   for row in g['rows']:detail.append('<tr>'+''.join('<td>'+e(str(v))+'</td>' for v in [g['buildName'],str(g['duration'])+'s',RACES[row['race']],f"{row['meanDps']:.2f}",f"±{row['ci95HalfWidth']:.2f}",f"{row['vsReference']['percent']:+.3f}%",f"±{row['vsReference']['ci95HalfWidthPercent']:.3f} pp",f"{row['secondsOomAvg']:.2f}s",f"{row['petDps']:.2f}",row['racial']['casts'],row['racial']['readLeylineCasts']])+'</tr>')
  notes=''.join('<li><b>'+e(p['name'])+':</b> '+badges(faction,p['id'])+' '+e(' '.join(m['reason'] for m in CONF[faction,p['id']]['markers']))+'</li>' for p in CAT['profiles'] if p['faction']==faction and p['className']==cls and CONF[faction,p['id']]['markers'])
  sections.append('<section><h2 style="color:'+CC[cls]+'">'+faction.title()+' / '+cls+'</h2><img loading="lazy" src="charts/'+faction+'-'+cls.lower()+'.png" alt="'+faction+' '+cls+' race differences"><ul class="caveatlist">'+notes+'</ul><details><summary>Exact DPS, paired uncertainty, mana waits and pet damage</summary><div class="scroll"><table><thead><tr><th>Build</th><th>Fight</th><th>Race</th><th>DPS</th><th>95% half-width</th><th>vs '+RACES[groups[0]['referenceRace']]+'</th><th>Paired half-width</th><th>OOM time</th><th>Pet DPS</th><th>Offensive racial casts</th><th>Read Leyline casts</th></tr></thead><tbody>'+''.join(detail)+'</tbody></table></div></details></section>')
excluded=''.join('<li>'+e(p['className']+' / '+p['name'])+': '+e('; '.join(p['warnings']))+'</li>' for p in CAT['excluded']) or '<li>No exported profiles excluded.</li>'
model='The recorded upstream engine is used without a racial overlay.' if P['model']['name']=='upstream' else 'The explicit notes-2026-10-27 adapter checks Blood Fury at 120 seconds, Berserking at 15 seconds and Touch of the Grave ICD at 15 seconds. Already adopted upstream values are left unchanged. Unexpected source drift stops the adapter. Status: '+e(json.dumps(P['model']['adjustments']))+'.'
intro='''<p class="eyebrow">WOWSIMS FOREVER / REPRODUCIBLE RACIAL DPS EXPERIMENT</p><h1>Race, build and fight length</h1><p class="lead">Developer gear and talents stay fixed while legal races are compared within each preset. Original APLs remain available alongside explicit activation checks for unused offensive racials.</p>'''
intro+='<div class="notice"><b>Model: '+e(P['model']['name'])+'</b><p>'+model+'</p><p>These findings are conditional on the recorded engine and presets. The report does not validate every mechanic or establish a universally best race.</p></div><nav>'+''.join('<a href="#'+f+'">'+f.title()+'</a>' for f in factions)+'<a href="#methods">Inputs and provenance</a></nav><div class="facts"><span><b>'+str(len(CAT['profiles']))+'</b>distinct faction/preset inputs</span><span><b>'+' / '.join(str(t) for t in DURATIONS)+'s</b>fixed fight lengths</span><span><b>'+str(A['settings']['iterations'])+'</b>iterations per primary cell</span></div>'
legend='''<section><h2>Small markers, specific reasons</h2><p><b>†</b> points to a qualitative caveat: developer Testing or Placeholder gear, measured mana waits, reviewed rotation issues, unresolved conditions, a specialized preset, an unused mana racial, or an explicit racial activation adjustment. Shared race/talent guard warnings remain in the validation dump and do not automatically lower confidence. Hover over a tag or read the class details. An unmarked preset is not an in-game validation claim.</p><p><b>~ / ≈</b> separately marks a close race comparison: less than 0.2% apart, a paired 95% sampling interval crossing zero, or an independent confirmation that remains close or exchanges the leader. The 0.2% cutoff is a reporting convention, not an uncertainty estimate.</p><p>Itemization is identical between races within a row. Gear tiers differ between presets and classes, so their raw DPS is not a class ranking. Small racial gaps can still change with gear, mana, pet contribution or cooldown timing.</p></section>'''
methods='<section id="methods"><h2>Inputs and provenance</h2><p>Simulator <code>'+P['snapshot']['commit']+'</code>; upstream source <code>'+P['snapshot']['upstreamSourceCommit']+'</code>. Game builds <code>'+e(json.dumps(P['gameBuilds']))+'</code>; hotfixes <code>'+e(json.dumps(P['hotfixes']))+'</code>. Tracked state: '+('clean' if not P['snapshot']['status'] else 'changes recorded in provenance')+'.</p><ul>'
for text in [
 f"One level-{CAT['config']['target']['level']} {CAT['config']['target']['mobType']} target, {CAT['config']['target']['armor']:,} armor, exact durations, zero duration variation, {100*CAT['config']['executeProportion20']:g}%/{100*CAT['config']['executeProportion35']:g}% execute windows, no incoming damage or forced encounter movement. Developer APL movement remains enabled. Pet damage is included.",
 'The shared raid/party/individual buffs and debuffs are preserved in profiles.json and every request. This is an abstract support configuration, not a validated raid roster. The current engine permits Windfury with Grace of Air. Utility, healing, tank survival and PvP are outside this damage objective.',
 'Current UI code exports equipment, enchants, item swaps, talents, professions, consumables and resolved rotations. Warlock uses the documented repository pre-raid fallback. No items are scored or optimized. Only reviewed faction counterparts with matching combat data are allowed, with per-iteration native equivalence controls. Unknown mappings or potentially active set changes stop the run.',
 'Race eligibility comes from the current generated class capabilities. New unknown race/faction assignments stop the run for policy review. Unsupported presets are retained in the coverage list below. One-race cases show eligibility only, not a damage advantage.',
 'Primary and target-type samples use seed '+str(A['settings']['seed'])+'. Independent confirmations use a separate seed and rerun only the leading pair. Exact counts and seeds are in cells.json. Paired ratios use aligned iteration seeds, sample variance and delta-method uncertainty. Intervals measure Monte Carlo error, with no family-wise multiple-comparison correction.',
 'Offensive on-use racial casts are checked at every duration. If a racial remains unused throughout, an additional controlled APL case adds only its spell-is-known guarded cast to every race. Original inputs/results remain saved. Unaffected races must reproduce every damage iteration. A still-unused offensive racial withholds the ranking. Existing active cooldown timing and mana tools remain the supplied APL behavior.',
 'Read Leyline cast counts are recorded. No mana cooldown threshold or timing is invented. A mana-limited cell with unused Read Leyline receives a separate caveat. Gnome resource effects, Priest class racials and all other effects remain the recorded engine implementation.',
 'An independent NumPy calculation checks means and covariance-based paired intervals. Request/result hashes, faction legality, race-only input differences, control equivalence, engine hashes and artifact links are verified. Source and tool hashes must remain unchanged during execution. These checks do not establish in-game accuracy.',
 'The default model is upstream. The optional dated notes adapter is explicit and fails on unrecognized source changes. Current source statements and model findings are distinct. The local developer library was consulted; the October 27 clarification is newer than its older S027 racial snapshot.',
 'The reusable commands, dependency setup, update workflow, resume and verified reuse behavior are documented in tools/dps-experiments/README.md. Generated archives stay local under ignored tmp/. Every run has its own immutable snapshot and report.'
]:methods+='<li>'+e(text)+'</li>'
methods+='</ul><h3>Coverage limitations</h3><ul>'+excluded+'</ul><p>Source: <a href="'+e(CAT['policy']['notesSource'],quote=True)+'">Blizzard racial clarification</a>. Recommendations here are simulation findings.</p></section>'
downloads='<section><h2>Downloads and verification</h2><p>'+ ' · '.join('<a href="'+name+'">'+title+'</a>' for name,title in [('race-comparison.csv','Primary CSV'),('analysis.json','Analysis'),('profiles.json','Presets and exact support'),('adjustments.json','APL adjustments'),('rotation-validations.json','APL validations'),('provenance.json','Provenance'),('cells.json','All cell summaries'),('controls.json','Equivalence controls'),('numerical-review.json','Independent numerical review'),('completion.json','Completion'),('artifact-hashes.json','Artifact hashes')])+'</p><p>'+ ' · '.join('<a href="charts/'+f+'-overview.png">'+f.title()+' poster</a> · <a href="charts/'+f+'-overview.svg">SVG</a>' for f in factions)+'</p></section>'
style='''*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#edf3fc;font:16px/1.65 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:48px 30px}h1{font-size:44px;line-height:1.15;letter-spacing:-1px}h2{font-size:26px;margin-top:0}.eyebrow{font-size:12px;color:#92a7c7;letter-spacing:2px}.lead{font-size:20px;color:#c2cee1}.notice{padding:22px;background:#302719;border:1px solid #765e32;border-radius:14px;color:#f4dfb5;margin:26px 0}nav{display:flex;gap:22px}.facts{display:flex;flex-wrap:wrap;gap:28px;margin:28px 0}.facts span{border-left:2px solid #546e96;padding-left:15px;color:#b6c5dc}.facts b{display:block;color:#edf3fc;font-size:23px}section{padding:28px;background:#121d30;border:1px solid #25344b;border-radius:16px;margin:28px 0}a{color:#80caff}img{max-width:100%;display:block;margin:25px auto;border-radius:14px}code{font-size:12px;color:#c6b3f3;overflow-wrap:anywhere}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap}th,td{text-align:right;padding:10px 12px;border-bottom:1px solid #2a3b55}th:first-child,td:first-child{text-align:left}th{color:#a9bedc}.picks td{text-align:left}.group th{text-align:left;font-size:16px;padding-top:26px}small{display:block;font-size:11px;color:#a1afc5}.badge{display:inline-block;font-size:10px;color:#d4c3a0;background:#292b31;border:1px solid #565147;border-radius:5px;padding:1px 6px;margin:2px 4px 2px 0}.muted{color:#a1afc5}.caveatlist{font-size:13px}summary{cursor:pointer;color:#9ed9f3;padding:12px 0}li{color:#b8c7dc;margin-bottom:12px}@media(max-width:750px){main{padding:24px 14px}h1{font-size:32px}section{padding:18px}.facts{gap:15px}}'''
(R/'report.html').write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Racial DPS comparison | '+P['snapshot']['commit'][:10]+'</title><style>'+style+'</style></head><body><main>'+intro+legend+''.join(sections)+methods+downloads+'</main></body></html>',encoding='utf-8')
(R/'plot-environment.json').write_text(json.dumps({'python':platform.python_version(),'numpy':np.__version__,'matplotlib':matplotlib.__version__},indent=2))
print('Rendered '+', '.join(factions)+' reports; independent numerical checks passed.')
