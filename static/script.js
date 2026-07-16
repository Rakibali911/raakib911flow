let currentTicker = "SPY";
let selectedExpiries = [];
let expiryData = [];

const layoutBase = {
  paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
  font:{color:'#8a94a3', size:10}, margin:{l:36,r:10,t:10,b:30},
  xaxis:{gridcolor:'rgba(255,255,255,0.05)', zeroline:false},
  yaxis:{gridcolor:'rgba(255,255,255,0.06)', zeroline:false},
  showlegend:false, dragmode:'pan'
};
const plotConfig = { displayModeBar:false, responsive:true, scrollZoom:true };

function fmtBig(n) {
  const abs = Math.abs(n);
  let s;
  if (abs >= 1e9) s = (n/1e9).toFixed(2) + 'B';
  else if (abs >= 1e6) s = (n/1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) s = (n/1e3).toFixed(2) + 'K';
  else s = n.toFixed(2);
  return (n >= 0 ? '+' : '') + s;
}

async function loadQuotes() {
  try {
    const res = await fetch('/api/quotes');
    const data = await res.json();
    document.querySelectorAll('.ticker-card').forEach(card => {
      const sym = card.dataset.ticker;
      if (data.quotes[sym] !== undefined) {
        card.querySelector('.px').innerText = '$' + data.quotes[sym];
      }
    });
  } catch (e) { console.error('quotes failed', e); }
}

async function loadExpiries() {
  const dteListEl = document.getElementById('dteList');
  dteListEl.innerHTML = '<div class="dte-loading">Loading expiries...</div>';
  document.getElementById('dteBtnLabel').innerText = 'DTE · loading...';
  try {
    const res = await fetch('/api/expiries?ticker=' + currentTicker);
    const data = await res.json();
    expiryData = data.expiries || [];
    dteListEl.innerHTML = '';
    selectedExpiries = [];
    expiryData.forEach((item, idx) => {
      const row = document.createElement('div');
      const isDefault = idx < 3; // auto-select first 3 nearest expiries
      row.className = 'dte-row' + (isDefault ? ' checked' : '');
      row.dataset.expiry = item.expiry;
      row.innerHTML = `<div class="dte-left"><div class="checkbox">${isDefault ? '✓' : ''}</div>
        <div><div>${item.dte} DTE</div><div class="dte-date">${item.date}</div></div></div>
        <div class="oi-tag">OI: ${item.oi}</div>`;
      row.addEventListener('click', () => {
        row.classList.toggle('checked');
        row.querySelector('.checkbox').innerText = row.classList.contains('checked') ? '✓' : '';
        updateDteLabel();
      });
      dteListEl.appendChild(row);
      if (isDefault) selectedExpiries.push(item.expiry);
    });
    updateDteLabel();
  } catch (e) {
    dteListEl.innerHTML = '<div class="dte-loading">Failed to load. Tap refresh.</div>';
  }
}

function updateDteLabel() {
  const checked = document.querySelectorAll('.dte-row.checked');
  document.getElementById('dteBtnLabel').innerText = 'DTE · ' + checked.length + ' selected';
  selectedExpiries = Array.from(checked).map(r => r.dataset.expiry);
}

function insightText(netGex, spot, flip) {
  if (netGex > 0) {
    return `Combined <b>Positive Gamma</b> across selected DTEs — dealers likely to suppress volatility. Pinning probable near current levels.`;
  } else {
    return `Combined <b>Negative Gamma</b> across selected DTEs — dealers likely amplify moves. Expect higher volatility, especially below flip point ${flip}.`;
  }
}

async function loadGex() {
  if (selectedExpiries.length === 0) {
    document.getElementById('insightTxt').innerText = 'Select at least one DTE first.';
    return;
  }
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  try {
    const url = `/api/gex?ticker=${currentTicker}&expiries=${selectedExpiries.join(',')}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      document.getElementById('insightTxt').innerText = data.error;
      btn.classList.remove('spinning');
      return;
    }

    document.getElementById('tsVal').innerText = data.updated;
    document.getElementById('statSpot').innerText = data.spot;
    document.getElementById('statCallWall').innerText = data.call_wall;
    document.getElementById('statPutWall').innerText = data.put_wall;
    document.getElementById('statNetGex').innerText = fmtBig(data.net_gex);
    document.getElementById('statNetGex').className = 'v ' + (data.net_gex >= 0 ? 'green' : 'red');
    document.getElementById('statNetDex').innerText = fmtBig(data.net_dex);
    document.getElementById('statNetDex').className = 'v ' + (data.net_dex >= 0 ? 'green' : 'red');
    document.getElementById('statFlip').innerText = data.flip_point;
    document.getElementById('statMaxPain').innerText = data.max_pain;
    document.getElementById('insightTxt').innerHTML = insightText(data.net_gex, data.spot, data.flip_point);

    const colors = arr => arr.map(v => v >= 0 ? '#00ffb2' : '#ff4d6d');
    const spot = data.spot;

    Plotly.newPlot('gexChart', [{ x:data.strikes, y:data.gex, type:'bar', marker:{color:colors(data.gex)} }], {
      ...layoutBase,
      shapes:[
        {type:'line', x0:spot, x1:spot, y0:0, y1:1, yref:'paper', line:{color:'#ffffff', width:1.5, dash:'dot'}},
        {type:'line', x0:data.call_wall, x1:data.call_wall, y0:0, y1:1, yref:'paper', line:{color:'#00ffb2', width:1, dash:'dash'}},
        {type:'line', x0:data.put_wall, x1:data.put_wall, y0:0, y1:1, yref:'paper', line:{color:'#ff4d6d', width:1, dash:'dash'}}
      ]
    }, plotConfig);

    Plotly.newPlot('dexChart', [{ x:data.strikes, y:data.dex, type:'bar', marker:{color:colors(data.dex)} }], {
      ...layoutBase,
      shapes:[{type:'line', x0:spot, x1:spot, y0:0, y1:1, yref:'paper', line:{color:'#ffffff', width:1.5, dash:'dot'}}]
    }, plotConfig);

    const cumGexX = data.cumulative_gex.map(p => p.strike);
    const cumGexY = data.cumulative_gex.map(p => p.value);
    Plotly.newPlot('cumGexChart', [{ x:cumGexX, y:cumGexY, type:'scatter', mode:'lines', line:{color:'#00ffb2', width:2}, fill:'tozeroy', fillcolor:'rgba(0,255,178,0.08)' }], layoutBase, plotConfig);

    const cumDexX = data.cumulative_dex.map(p => p.strike);
    const cumDexY = data.cumulative_dex.map(p => p.value);
    Plotly.newPlot('cumDexChart', [{ x:cumDexX, y:cumDexY, type:'scatter', mode:'lines', line:{color:'#7c5cff', width:2}, fill:'tozeroy', fillcolor:'rgba(124,92,255,0.08)' }], layoutBase, plotConfig);

  } catch (e) {
    console.error(e);
    document.getElementById('insightTxt').innerText = 'Failed to load data. Tap refresh to retry.';
  }
  btn.classList.remove('spinning');
}

document.getElementById('dteBtn').addEventListener('click', () => {
  document.getElementById('dtePanel').classList.toggle('show');
  document.getElementById('dteBtn').classList.toggle('open');
});
document.getElementById('doneBtn').addEventListener('click', () => {
  document.getElementById('dtePanel').classList.remove('show');
  document.getElementById('dteBtn').classList.remove('open');
});
document.getElementById('refreshBtn').addEventListener('click', loadGex);

document.querySelectorAll('.ticker-card').forEach(card => {
  card.addEventListener('click', async () => {
    document.querySelectorAll('.ticker-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    currentTicker = card.dataset.ticker;
    await loadExpiries();
    await loadGex();
  });
});

// initial load
loadQuotes();
loadExpiries().then(loadGex);
setInterval(loadQuotes, 30000);
