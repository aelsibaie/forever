"""Report the pinned Shadow engine comparison without mixing gear scenarios."""

import json
import math
import sys
import hashlib
import platform
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from report_details import STYLE, e, read, table

root=Path(sys.argv[1]).resolve()
data=read(root/'results.json')
provenance=read(root/'provenance.json')
completion=read(root/'completion.json')
primary=read(root/'primary-provenance.json')
assert completion['normalizedRotationEquivalent'] and completion['primaryEngineUnchanged']
rows=data['rows']
assert len(rows)==len(provenance['settings']['durations'])*2*4
for row in rows:
    for folder,field in [('requests','requestSha256'),('results','resultSha256')]:
        assert hashlib.sha256((root/folder/(row['key']+'.json')).read_bytes()).hexdigest()==row[field], 'Changed '+folder+': '+row['key']
engines=['wowsims','gunba','gunba-resource-control']
labels={'wowsims':'WoWSims developer preset','gunba':'Gunba translated inputs','gunba-resource-control':'Gunba resource-stat control'}
colors=['#81c9e9','#b5a0e7','#d7ba76']
summary=[]
for duration in provenance['settings']['durations']:
    for engine in engines:
        pair={r['race']:r for r in rows if r['engine']==engine and r['duration']==duration}
        h,d=pair['RaceHuman'],pair['RaceDwarf']
        arrays=[]
        for row in [h,d]:
            raw=read(root/'results'/(row['key']+'.json'))
            assert raw['iterationsDone']==row['iterations']
            assert len(raw['raidMetrics']['parties'][0]['players'][0]['dps']['allValues'])==row['iterations']
            arrays.append(np.array(raw['raidMetrics']['parties'][0]['players'][0]['dps']['allValues']))
        x,y=arrays
        for values,row in zip(arrays,[h,d]):
            assert abs(float(values.mean())-row['meanDps'])<1e-8
            assert abs(1.959963984540054*float(values.std(ddof=1))/math.sqrt(len(values))-row['ci95HalfWidth'])<1e-8
        ratio=x.mean()/y.mean();cov=np.cov(np.stack(arrays),ddof=1)
        half=100*1.959963984540054*math.sqrt(max(0,float(cov[0,0]+ratio*ratio*cov[1,1]-2*ratio*cov[0,1]))/len(x))/y.mean()
        summary.append({'engine':engine,'duration':duration,'humanDps':h['meanDps'],'dwarfDps':d['meanDps'],'humanOverDwarfPercent':100*(ratio-1),'ci95HalfWidthPercent':half,'iterations':h['iterations']})
differences=[]
for duration in provenance['settings']['durations']:
    for race in ['RaceHuman','RaceDwarf']:
        main=next(r for r in rows if r['engine']=='wowsims' and r['race']==race and r['duration']==duration)
        for engine in ['gunba','gunba-resource-control']:
            other=next(r for r in rows if r['engine']==engine and r['race']==race and r['duration']==duration)
            differences.append({'duration':duration,'race':race,'engine':engine,'gunbaMinusWowsimsDps':other['meanDps']-main['meanDps'],'independentCi95HalfWidthDps':math.hypot(main['ci95HalfWidth'],other['ci95HalfWidth'])})
(root/'comparison.json').write_text(json.dumps({'results':summary,'absoluteDifferences':differences,'uncertainty':'Paired ratio intervals within each engine only. Cross-engine samples are not paired.'},indent=2),encoding='utf-8')
plt.rcParams.update({'font.family':'DejaVu Sans','figure.facecolor':'#0b1220','axes.facecolor':'#0b1220','text.color':'#edf3fc','axes.labelcolor':'#a1afc5','xtick.color':'#a1afc5','ytick.color':'#edf3fc'})
durations=provenance['settings']['durations']
fig,axes=plt.subplots(1,len(durations),figsize=(15,5.6),squeeze=False,sharey=True)
for ax,duration in zip(axes[0],durations):
    ax.axvspan(-.2,.2,color='#273950',alpha=.6);ax.axvline(0,color='#8d9eb5',lw=.8)
    for i,engine in enumerate(engines):
        row=next(r for r in summary if r['engine']==engine and r['duration']==duration)
        ax.errorbar(row['humanOverDwarfPercent'],i,xerr=row['ci95HalfWidthPercent'],fmt='o',color=colors[i],capsize=4,markersize=7)
    ax.set_title(str(duration)+' seconds',pad=16);ax.set_xlabel('Human versus Dwarf (%)');ax.grid(axis='x',alpha=.12)
    for spine in ax.spines.values():spine.set_visible(False)
axes[0,0].set_yticks(range(3),[labels[x] for x in engines]);axes[0,0].invert_yaxis()
fig.suptitle('Same developer equipment, named talents and effective rotation',fontsize=17,fontweight='bold',x=.04,ha='left')
fig.subplots_adjust(left=.25,right=.97,top=.79,bottom=.24,wspace=.18)
fig.text(.04,.09,'Paired 95% Monte Carlo intervals within each engine. Shading: ±0.2% reporting convention; model error is separate.',fontsize=9,color='#a1afc5')
fig.text(.04,.035,'WoWSims '+provenance['settings']['primarySource'][:10]+' | Gunba '+provenance['settings']['gunbaRevision'][:10]+' | analytics '+provenance['settings']['analyticsCommit'][:10]+' | '+str(provenance['settings']['iterations'])+' iterations/race | seeds '+str(provenance['settings']['seed'])+' / '+str(provenance['settings']['gunbaSeed']),fontsize=8.5,color='#a1afc5')
fig.savefig(root/'comparison.png',dpi=170);fig.savefig(root/'comparison.svg');plt.close(fig)
display=[[str(r['duration']),e(labels[r['engine']]),f"{r['humanDps']:.3f}",f"{r['dwarfDps']:.3f}",f"{r['humanOverDwarfPercent']:+.3f}% ± {r['ci95HalfWidthPercent']:.3f} pp"] for r in summary]
calibration=read(root/'stat-calibration.json')
calibration_rows=[[e(r['race']),r['duration'],e(c['name']),f"{c['before']:.6f}",f"{c['target']:.6f}",f"{c['bonusStatDelta']:+.9f}"] for r in calibration for c in r['changes']]
replay=[[e(r['engine']),e(r['race']),r['duration'],e(r['seed']),'<a href="requests/'+e(r['key'])+'.json">Input</a> · <a href="results/'+e(r['key'])+'.json">Output</a>'] for r in rows]
breakdowns=[]
crit_rows=[]
for duration in durations:
    for race in ['RaceHuman','RaceDwarf']:
        actions={}
        for engine in engines:
            row=next(r for r in rows if r['engine']==engine and r['duration']==duration and r['race']==race)
            player=read(root/'results'/(row['key']+'.json'))['raidMetrics']['parties'][0]['players'][0]
            for action in player['actions']:
                if not action['id'].get('spellId') or not action['targets']:
                    continue
                target=action['targets'][0]
                if target['damage']<=0:
                    continue
                crit_rows.append([duration,e(race),e(labels[engine]),action['id']['spellId'],f"{target['casts']/row['iterations']:.3f}",f"{target['crits']/row['iterations']:.3f}",f"{target['ticks']/row['iterations']:.3f}",f"{target['critTicks']/row['iterations']:.3f}"])
            for action in row['damageActions']:
                key=str(action['id'].get('spellId',action['id'].get('itemId','other')))
                actions.setdefault(key,{})[engine]=action['dps']
        for action,values in actions.items():
            breakdowns.append([duration,e(race),e(action)]+[f"{values.get(engine,0):.3f}" for engine in engines])
body='<h1>Matched Shadow Priest engine comparison</h1><p>WoWSims remains the main simulator. Both comparisons retain the developer equipment, enchants and named talent allocation. The second Gunba case calibrates non-gear attributes/resources and is shown separately.</p><section><h2>Results</h2><img style="width:100%" src="comparison.png" alt="Human relative to Dwarf in each engine and fight length">'+table(['Seconds','Case','Human DPS','Dwarf DPS','Human versus Dwarf ± 95% half-width'],display)+'</section>'
body+='<section><h2>Absolute engine difference</h2><p>Negative values mean Gunba produces less DPS. These intervals use independent sampling errors; shared numeric seeds do not align random draws between engines. A residual difference does not identify which engine matches the game.</p>'+table(['Seconds','Race','Case','Gunba minus WoWSims DPS ± 95% half-width'],[[r['duration'],e(r['race']),e(labels[r['engine']]),f"{r['gunbaMinusWowsimsDps']:+.3f} ± {r['independentCi95HalfWidthDps']:.3f}"] for r in differences])+'</section>'
body+='<section><h2>What is controlled</h2><ul>'+''.join('<li>'+e(s)+'</li>' for s in provenance['assumptions'])+'</ul><p>WoWSims normalized-rotation controls reproduce every original damage iteration. The stat control matches Stamina, Intellect, Spirit, Mana, Health, MP5 and total/Shadow spell damage; it does not change equipment or talents. Remaining engine rules, spell implementations and event ordering are the subject of comparison. No input is called a validated in-game optimum.</p><p>Source '+e(provenance['settings']['primarySource'])+'; Gunba '+e(provenance['settings']['gunbaRevision'])+'. The archived primary provenance supplies the exact game build and hotfix metadata. Common numeric seeds do not pair draws across different engines.</p></section>'
body+='<section><h2>Resource calibration audit</h2>'+table(['Race','Seconds','Attribute','Translated final','Control final','Non-gear bonus delta'],calibration_rows)+'</section>'
body+='<section><h2>Damage accounting</h2><p>Spell/item IDs are retained for direct source inspection. Actions missing from a case are shown as zero.</p>'+table(['Seconds','Race','Action ID']+[labels[x] for x in engines],breakdowns)+'</section>'
body+='<section><h2>Cast and crit accounting</h2><p>Means per fight. Noncritical ticks and critical ticks are separate counters. These expose per-spell behavior that matching final sheet stats cannot establish; they do not establish which engine matches the game.</p>'+table(['Seconds','Race','Case','Spell ID','Casts','Direct crits','Noncritical ticks','Critical ticks'],crit_rows)+'</section>'
body+='<section><h2>Inputs, outputs and verification</h2><p>Game builds '+e(json.dumps(primary['gameBuilds']))+'; hotfixes '+e(json.dumps(primary['hotfixes']))+'. Main model '+e(primary['model']['name'])+'. Analytics '+e(provenance['settings']['analyticsCommit'])+'.</p>'+table(['Engine','Race','Seconds','Seed','Replay'],replay)+'<p><a href="provenance.json">Provenance and binary hashes</a> · <a href="primary-provenance.json">Primary model and game data</a> · <a href="completion.json">Controls</a> · <a href="stat-calibration.json">Calibration data</a> · <a href="comparison.json">Comparison data</a> · <a href="stats/equipment.json">Resolved developer equipment</a></p><p>Archived engines: <code>engine/wowsim.exe</code> uses <code>sim --infile INPUT --outfile OUTPUT</code>; <code>engine/gunba.exe</code> uses <code>sim INPUT OUTPUT</code>. Executable suffixes follow the host platform.</p><p>Sources: <a href="https://github.com/wowsims/forever/tree/'+e(provenance['settings']['primarySource'])+'">WoWSims source</a> · <a href="https://github.com/gunba/wow-forever-sim/tree/'+e(provenance['settings']['gunbaRevision'])+'">Gunba source</a>. This compares the two Go engines; it does not reproduce Finsemble’s separate model.</p></section>'
(root/'report.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matched Shadow Priest comparison</title><style>'+STYLE+'</style><main>'+body+'</main></html>',encoding='utf-8')
artifacts=[p for p in root.rglob('*') if p.is_file() and p.name!='report-provenance.json']
(root/'report-provenance.json').write_text(json.dumps({'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'python':platform.python_version(),'numpy':np.__version__,'matplotlib':matplotlib.__version__,'artifacts':{p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts}},indent=2),encoding='utf-8')
print('Rendered matched Shadow comparison: '+str(root/'report.html'))
