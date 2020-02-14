window.onload = async function () {
	let visualNode = await main();
	document.getElementsByTagName('body')[0].appendChild(visualNode);
}

async function main () {

	const data = await d3.json('keepteam_graph.json');
// data.children = data.children.slice(0,3)

	const width = window.innerWidth;
	const height = window.innerHeight;
  const root = d3.hierarchy(data);
  const links = root.links();
  const nodes = root.descendants();
  const circleSize = 80;
  const depthsSizes = [1, 0.9, 0.75, 0.5, 0.3, 0.2, 0.2, 0.2, 0.2, 0.2]
  const linkDistances = [4, 2, 0.9, 0.6, 0.4, 0.2, 0.2, 0.2, 0.2];
  const linkStrengths = [0.5, 0.8, 1.2, 1.8, 2, 2];
  const chargeStrengths = [8, 6, 4, 2, 1];

  const getCircleSize = d => circleSize * depthsSizes[d.depth];
  const getLinkDistance = d => circleSize * linkDistances[d.source.depth];
  const getLinkStrength = d => linkStrengths[d.source.depth];
  const getChargeStrength = d => -circleSize*chargeStrengths[d.source.depth];

  const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links)
      	.id(d => d.id)
      	.distance(getLinkDistance)
      	.strength(getLinkStrength))
      .force("charge", d3.forceManyBody().strength(-circleSize*2))
      .force("x", d3.forceX())
      .force("y", d3.forceY());

  const svg = d3.create("svg")
      .attr("viewBox", [-width / 2, -height / 2, width, height])
      .attr("height", height)
      .attr("width", width)

  const link = svg.append("g")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 1)
    .selectAll("line")
    .data(links)
    .join("line");

  const avatars = svg.append("g")
    .append("defs")
  	.selectAll("avatars")
    .data(nodes)
    .join("pattern")
    	.attr("id", d => d.data.id)	
    	.attr("x", 0)
    	.attr("y", 0)
    	.attr("patternUnits", "objectBoundingBox")
    	.attr("height", 1)
    	.attr("width", 1)
    	.append("image")
    		.attr("x", 0)
    		.attr("y", 0)
    		.attr("height", getCircleSize)
    		.attr("width",  getCircleSize)
	    	.attr("xlink:href", d => 'photos/' + d.data.id + '.jpg')

  const node = svg.append("g")
      .attr("fill", "#fff")
      .attr("stroke", "#000")
      .attr("stroke-width", 1)
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    	.attr("fill", d => `url('#${d.data.id}')`)
      .attr("stroke", d => d.children ? "#0AA" : "#000")
      .attr("stroke-width", d => d.children ? 2 : 1)
      .attr("r", d => { return getCircleSize(d)/2 })
      .call(drag(simulation));

  node.append("title")
      .text(d => d.data.name);


  simulation.on("tick", () => {
    link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

    node
        .attr("cx", d => d.x)
        .attr("cy", d => d.y);
  });

  // invalidation.then(() => simulation.stop());

  return svg.node();
}

  
function drag (simulation) {
  
  function dragstarted(d) {
    if (!d3.event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  
  function dragged(d) {
    d.fx = d3.event.x;
    d.fy = d3.event.y;
  }
  
  function dragended(d) {
    if (!d3.event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }
  
  return d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);
}