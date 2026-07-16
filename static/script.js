let currentTicker = "SPY";
let selectedExpiries = [];
let expiryData = [];

const plotConfig = {
  displayModeBar: true,
  displaylogo: false,
  responsive: true,
  scrollZoom: true,
  modeBarButtons: [['zoomIn2d','zoomOut2d','autoScale2d','resetScale2d','pan2d']]
};

function fmtBig(n) {
  const abs = Math.abs(n);
  let s;
  if (abs >= 1e9) s = (n/1e9).toFixed(2)+'B';
  else if (abs >= 1e6) s = (n/1e6).toFixed(2)+'M';
  else if (abs >= 1e3) s = (n/1e3).toFixed(2)+'K';
  else s = n.toFixed(2);
  return (n >= 0 ? '+' : '')+s;
}

async function loadQuotes() {
  try {
    const res = await fetch('/api/quotes');
    const data = await res.json();
    document.querySelectorAll('.ticker-card').forEach(card => {
      const sym = card.dataset.ticker;
      if (data.quotes[sym] !== undefined)
        card.querySelector('.px').innerText = '$'+data.quotes[sym];
    });
  } catch(e) { console.error('quotes failed', e); }
}

async function loadExpiries() {
  const dteListEl = document.getElementById('dteList');
  dteListEl.innerHTML = '<div class="dte-loading">Loading expiries...</div>';
  document.getElementById('dteBtnLabel').innerText = 'Expiries · loading...';
  try {
    const res = await fetch('/api/expiries?ticker='+currentTicker);
    const data = await res.json();
    expiryData = data.expiries || [];
    dteListEl.innerHTML = '';
    selectedExpiries = [];
    expiryData.forEach((item, idx) => {
      const row = document.createElement('div');
      const isDefault = idx < 3;
      row.className = 'dte-row'+(isDefault ? ' checked' : '');
      row.dataset.expiry = item.expiry;
      row.innerHTML = `<div class="dte-left">
        <div class="checkbox">${isDefault ? '✓' : ''}</div>
        <div><div style="font-weight:700">${item.date}</div><div class="dte-date">${item.dte} days away</div></div>
      </div>
      <div class="oi-tag">OI: ${item.oi.toLocaleString()}</div>`;
      row.addEventListener('click', () => {
        row.classList.toggle('checked');
        row.querySelector('.checkbox').innerText = row.classList.contains('checked') ? '✓' : '';
        updateExpiryLabel();
      });
      dteListEl.appendChild(row);
      if (isDefault) selectedExpiries.push(item.expiry);
    });
    updateExpiryLabel();
  } catch(e) {
    dteListEl.innerHTML = '<div class="dte-loading">Failed to load. Tap refresh.</div>';
  }
}

function updateExpiryLabel() {
  const checked = document.querySelectorAll('.dte-row.checked');
  document.getElementById('dteBtnLabel').innerText = 'Expiries · '+checked.length+' selected';
  selectedExpiries = Array.from(checked).map(r => r.dataset.expiry);
}

function insightText(netGex, flip) {
  if (netGex > 0)
    return `Combined <b>Positive Gamma</b> across selected expiries — dealers likely to suppress volatility. Pinning probable near current levels.`;
  else
    return `Combined <b>Negative Gamma</b> across selected expiries — dealers amplify moves. Expect volatility, especially below flip point <b>${flip}</b>.`;
}

async function loadGex() {
  if (selectedExpiries.length === 0) {
    document.getElementById('insightTxt').innerText = 'Select at least one expiry first.';
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

    // Update stat strip
    document.getElementById('tsVal').innerText = data.updated;
    document.getElementById('statSpot').innerText = data.spot;
    document.getElementById('statCallWall').innerText = data.call_wall;
    document.getElementById('statPutWall').innerText = data.put_wall;
    document.getElementById('statNetGex').innerText = fmtBig(data.net_gex);
    document.getElementById('statNetGex').className = 'v '+(data.net_gex >= 0 ? 'green' : 'red');
    document.getElementById('statNetDex').innerText = fmtBig(data.net_dex);
    document.getElementById('statNetDex').className = 'v '+(data.net_dex >= 0 ? 'green' : 'red');
    document.getElementById('statFlip').innerText = data.flip_point;
    document.getElementById('statMaxPain').innerText = data.max_pain;
    document.getElementById('insightTxt').innerHTML = insightText(data.net_gex, data.flip_point);

    const spot = data.spot;
    const strikes = data.strikes;
    const gex = data.gex;
    const dex = data.dex;
    const cumGex = data.cumulative_gex.map(p => p.value);
    const cumDex = data.cumulative_dex.map(p => p.value);

    const gexColors = gex.map(v => v >= 0 ? 'rgba(57,255,20,0.45)' : 'rgba(255,49,49,0.45)');
    const dexColors = dex.map(v => v >= 0 ? 'rgba(57,255,20,0.45)' : 'rgba(255,49,49,0.45)');

    // Hover template combining all 4 values
    const customHover = strikes.map((s,i) =>
      `<b>Strike ${s}</b><br>`+
      `GEX: ${fmtBig(gex[i])}<br>`+
      `Cum GEX: ${fmtBig(cumGex[i])}<br>`+
      `DEX: ${fmtBig(dex[i])}<br>`+
      `Cum DEX: ${fmtBig(cumDex[i])}`+
      `<extra></extra>`
    );

    const traces = [
      // Upper panel: GEX Bars
      {
        name: 'GEX',
        x: strikes, y: gex,
        type: 'bar',
        marker: { color: gexColors },
        yaxis: 'y', xaxis: 'x',
        hovertemplate: customHover,
        showlegend: true
      },
      // Upper panel: Cumulative GEX line (secondary axis)
      {
        name: 'Cum GEX',
        x: strikes, y: cumGex,
        type: 'scatter', mode: 'lines',
        line: { color: '#00FFFF', width: 3, shape: 'spline', smoothing: 0.4 },
        yaxis: 'y3', xaxis: 'x',
        hovertemplate: customHover,
        showlegend: true
      },
      // Lower panel: DEX Bars
      {
        name: 'DEX',
        x: strikes, y: dex,
        type: 'bar',
        marker: { color: dexColors },
        yaxis: 'y2', xaxis: 'x',
        hovertemplate: customHover,
        showlegend: true
      },
      // Lower panel: Cumulative DEX line (secondary axis)
      {
        name: 'Cum DEX',
        x: strikes, y: cumDex,
        type: 'scatter', mode: 'lines',
        line: { color: '#FFFF00', width: 3, shape: 'spline', smoothing: 0.4 },
        yaxis: 'y4', xaxis: 'x',
        hovertemplate: customHover,
        showlegend: true
      }
    ];

    const lo = spot * 0.87;
    const hi = spot * 1.13;

    const layout = {
      paper_bgcolor: '#000000',
      plot_bgcolor: '#000000',
      height: 650,

      title: {
        text: `${currentTicker} FLOW ENGINE<br><span style="font-size:9px;color:#888888">Time: ${data.updated} &nbsp;|&nbsp; Spot: ${spot} &nbsp;|&nbsp; Call Wall: ${data.call_wall} &nbsp;|&nbsp; Put Wall: ${data.put_wall}</span>`,
        font: { size: 13, color: '#ffffff' },
        x: 0.5, xanchor: 'center'
      },

      bargap: 0.35,

      // Upper panel Y — GEX bars
      yaxis: {
        domain: [0.53, 1.0],
        showgrid: false,
        zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)', zerolinewidth: 1,
        color: '#555', tickfont: { size: 9, color: '#555' },
        title: { text: 'GEX', font: { color: '#39FF14', size: 9 } }
      },
      // Lower panel Y — DEX bars
      yaxis2: {
        domain: [0, 0.47],
        showgrid: false,
        zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)', zerolinewidth: 1,
        color: '#555', tickfont: { size: 9, color: '#555' },
        title: { text: 'DEX', font: { color: '#39FF14', size: 9 } }
      },
      // Secondary Y — Cum GEX (right, upper)
      yaxis3: {
        domain: [0.53, 1.0],
        overlaying: 'y', side: 'right',
        showgrid: false, zeroline: false,
        showticklabels: false, color: '#00FFFF'
      },
      // Secondary Y — Cum DEX (right, lower)
      yaxis4: {
        domain: [0, 0.47],
        overlaying: 'y2', side: 'right',
        showgrid: false, zeroline: false,
        showticklabels: false, color: '#FFFF00'
      },

      xaxis: {
        range: [lo, hi],
        showgrid: false,
        color: '#555', tickfont: { size: 9, color: '#888' },
        tickangle: -45,
        zeroline: false
      },

      legend: {
        orientation: 'h',
        x: 0.5, xanchor: 'center',
        y: 1.08, yanchor: 'bottom',
        font: { color: '#aaaaaa', size: 10 },
        bgcolor: 'rgba(0,0,0,0)'
      },

      hovermode: 'x',

      // Vertical lines — span full chart via paper ref
      shapes: [
        { type:'line', xref:'x', yref:'paper', x0:spot, x1:spot, y0:0, y1:1,
          line:{ color:'#FFFFFF', width:2, dash:'solid' } },
        { type:'line', xref:'x', yref:'paper', x0:data.call_wall, x1:data.call_wall, y0:0, y1:1,
          line:{ color:'#FFDD00', width:2, dash:'dash' } },
        { type:'line', xref:'x', yref:'paper', x0:data.put_wall, x1:data.put_wall, y0:0, y1:1,
          line:{ color:'#FF3300', width:2, dash:'dash' } }
      ],

      annotations: [
        { xref:'x', yref:'paper', x:spot, y:1.01, text:'SPOT', showarrow:false,
          font:{ color:'#FFFFFF', size:8 }, xanchor:'left' },
        { xref:'x', yref:'paper', x:data.call_wall, y:0.97, text:'CALL WALL', showarrow:false,
          font:{ color:'#FFDD00', size:8 }, xanchor:'left' },
        { xref:'x', yref:'paper', x:data.put_wall, y:0.93, text:'PUT WALL', showarrow:false,
          font:{ color:'#FF3300', size:8 }, xanchor:'left' }
      ],

      margin: { l: 45, r: 45, t: 90, b: 55 },
      font: { color: '#aaaaaa' },
      dragmode: 'pan'
    };

    Plotly.newPlot('mainChart', traces, layout, plotConfig);

  } catch(e) {
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

loadQuotes();
loadExpiries().then(loadGex);
setInterval(loadQuotes, 30000);
