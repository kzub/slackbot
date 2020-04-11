/* global document window d3 Promise*/
const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setLoading = (on) => {
  document.getElementById("loadingImg").style.display = on ? 'inline' : 'none';
};

const setLoadPercent = (p, a) => {
  document.getElementById("loadPercent").innerHTML = Math.floor(100*p/a) + '%';
};

const setUsersCount = (count) => {
  document.getElementById("usersCount").innerHTML = count;
}

const updateHash = () => {
  const [,, userId] = document.location.hash.slice(1).split('/');
  const date1 = new Date(document.getElementById('fromDate').value);
  const date2 = new Date(document.getElementById('toDate').value);
  document.location.hash = `#${document.getElementById('fromDate').value}/${document.getElementById('toDate').value}/${userId||''}`;
  const daysCount = Math.ceil((date2 - date1) / (24*60*60*1000)) + 1;
  document.getElementById("daysCount").innerHTML = daysCount;
};

window.onload = async () => {
  const [hashFrom, hashTo, userId] = document.location.hash.slice(1).split('/');
  let date1, date2;
  if (hashFrom && hashTo) {
    date1 = new Date(hashFrom);
    date2 = new Date(hashTo);
  } else {
    date1 = new Date();
    date2 = new Date(date1.valueOf());
    date1.setHours(-5*24);
  }

  document.getElementById('fromDate').value = date1.toJSON().slice(0, 10);
  document.getElementById('toDate').value = date2.toJSON().slice(0, 10);

  document.getElementById('btnLoad').onclick = function() {
    loadData(document.getElementById('fromDate').value, document.getElementById('toDate').value, userId);
  }

  updateHash();
  document.getElementById('btnLoad').click();
  document.getElementById('fromDate').onchange = updateHash;
  document.getElementById('toDate').onchange = updateHash;
};

// demension constants
const rectSizeX = 3;
const rectSizeY = 12;
const vSpacing = 1;
const annotateSize = 300;
const vHeight = vSpacing + rectSizeY;
let firstTime = true;

async function loadData (from, to, userId) {
  setLoading(true);
  setLoadPercent(0, 1);
  const svg = d3.select("#screen")
  svg.selectAll(".vLine").remove();
  svg.selectAll(".vCursor").remove();

  let info;
  try {
    if (userId) {
      info = (await d3.json(`user/${userId}/${from}/${to}/`, { redirect: 'manual' })).data;
    } else {
      info = (await d3.json(`activity/${from}/${to}/`, { redirect: 'manual' })).data;
    }
  } catch (err) {
    console.error('fetch error', err);
    document.location.reload(); // in case of redirect on google auth session exired
    return;
  }
  if (!info.length) {
    setLoading(false);
    return
  }  
  setUsersCount(info.length);

  const dataWidth = info[0].activity.length + 1;
  const scale = d3.scaleLinear()
                  .domain([0, 24])
                  .range([rectSizeX, rectSizeX * (dataWidth + 1)]);

  const x_axis = d3.axisTop()
                   .scale(scale);

  if (firstTime) {
    // ----------------- timescale ---------------------------------
    d3.select("#timescale")
      .style("display", "block")
      .attr("width", rectSizeX * (dataWidth + 4))
      .attr("height", 21)
      .append("g")
        .style("transform", `translate(${rectSizeX}px, 20px)`)
        .call(x_axis);
    // -------------------------------------------------------------
    firstTime = false;
  }
  svg
    .attr("width",  rectSizeX * (dataWidth) + annotateSize)
    .attr("height", (rectSizeY + vSpacing) * info.length)
    .style("cursor", "crosshair")
    .style("display", "block");

  const addCursor = (selection) => {
    const lineBlur = selection.append("g")
      .style("display", "none")
      .attr("class", "vCursor")
    lineBlur.append("rect")
      .attr("x", 0)
      .attr("y", -0.5*(rectSizeY + vSpacing))
      .attr("width", rectSizeX*dataWidth + annotateSize)
      .attr("height", 1.5*(rectSizeY + vSpacing))
    lineBlur.append("rect")
      .attr("x", 0)
      .attr("y", (rectSizeY + vSpacing)*2)
      .attr("width", rectSizeX*dataWidth + annotateSize)
      .attr("height", 1.5*(rectSizeY + vSpacing))
    lineBlur.append("g")
      .attr("class", "vCursorAxes")
      .style("transform", `translate(${-2*rectSizeX}px, 12px)`)
      .call(x_axis);
  };

  const addRow = (selection, data, index) => {
    const line = selection
      .append("g")
        .data([{ data, index }])
        .attr("class", (d) => {
          if (d.data.weekend) { return 'vLine vWeekend'; }
          return "vLine";
        })
        .on("mouseover", (d) => {
          d3.select('.vCursor')
            .style("transform", `translate(${rectSizeX}px, ${vHeight*(d.index - 1)}px)`)
            .style("display", "block")
        })
        .on("mouseout", () => {
          d3.select('.vCursor').style("display", "none")
        })
        .on("click", (d) => {
          window.open(`${document.location.href}${d.data.userId}`, '_blank');
        })
        .style("transform", (d) => `translate(${rectSizeX}px, ${vHeight * d.index}px)`)

    line
      .append("text")
      .text(d => `${d.data.userName} ${d.data.userSum || ([d.data.date, d.data.weekDay].join(' '))}`)
      .style("transform", `translate(${rectSizeX * dataWidth - 1}px, ${vHeight-3}px)`)
      .attr("class", "annotate")

    line
      .selectAll("rect")
      .data(d => d.data.activity)
      .join("rect")
        .attr("fill", d3.interpolateViridis)
        .attr("x", (d, i) => rectSizeX * i)
        .attr("y", 0)
        .attr("width", rectSizeX)
        .attr("height", rectSizeY)
  };

  for (let index in info) {
    svg.call(addRow, info[index], index);
    if (index % 50 === 0) {
      setLoadPercent(index, info.length-1);
      await sleep(0); // brake sync to let DOM draw new line
    }
  }

  svg.call(addCursor); // must be last to be over other svg elements

  setLoading(false);
}