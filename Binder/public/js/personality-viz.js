// Binder/public/js/personality-viz.js
// D3.js v7 bubble visualization for personality traits

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

const CATEGORY_COLORS = {
  skills:        '#E8654A',  // Coral
  interests:     '#4A90D9',  // Blue
  values:        '#4A8C6F',  // Sage
  communication: '#F0A030',  // Gold
  availability:  '#7B6CB0',  // Lavender
};

const CATEGORY_LABELS = {
  skills:        'מיומנויות',
  interests:     'תחומי עניין',
  values:        'ערכים',
  communication: 'סגנון תקשורת',
  availability:  'זמינות',
};

const MIN_RADIUS = 10;  // diameter 20px per spec
const MAX_RADIUS = 40;  // diameter 80px per spec

/**
 * Render personality bubbles into a container
 * @param {HTMLElement} container - DOM element to render into
 * @param {Array} traits - [{name, weight, category}, ...]
 * @param {object} options - { interactive: boolean, width?: number, height?: number, onTraitClick?: fn, onTraitDelete?: fn }
 * @returns {{ update: (traits) => void, destroy: () => void }}
 */
export function renderBubbles(container, traits, options = {}) {
  const {
    interactive = false,
    width = container.clientWidth || 360,
    height = container.clientHeight || 360,
    onTraitClick = null,
    onTraitDelete = null,
  } = options;

  // Clear container
  container.innerHTML = '';

  if (!traits || traits.length === 0) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:0.88rem;">אין נתוני אישיות עדיין</div>';
    return { update: () => {}, destroy: () => {} };
  }

  // Create SVG
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`)
    .style('overflow', 'visible');

  // Map traits to nodes
  const nodes = traits.map((t, i) => ({
    ...t,
    id: i,
    radius: MIN_RADIUS + t.weight * (MAX_RADIUS - MIN_RADIUS),
    color: CATEGORY_COLORS[t.category] || '#888',
  }));

  // Category cluster centers
  const categories = [...new Set(nodes.map(n => n.category))];
  const clusterCenters = {};
  const angleStep = (2 * Math.PI) / categories.length;
  const clusterRadius = Math.min(width, height) * 0.25;
  categories.forEach((cat, i) => {
    clusterCenters[cat] = {
      x: width / 2 + clusterRadius * Math.cos(angleStep * i - Math.PI / 2),
      y: height / 2 + clusterRadius * Math.sin(angleStep * i - Math.PI / 2),
    };
  });

  // Force simulation
  const simulation = d3.forceSimulation(nodes)
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.02))
    .force('charge', d3.forceManyBody().strength(-5))
    .force('collide', d3.forceCollide(d => d.radius + 3).strength(0.8))
    .force('cluster', (alpha) => {
      nodes.forEach(d => {
        const center = clusterCenters[d.category];
        if (!center) return;
        d.vx += (center.x - d.x) * alpha * 0.15;
        d.vy += (center.y - d.y) * alpha * 0.15;
      });
    })
    .force('bounds', () => {
      nodes.forEach(d => {
        d.x = Math.max(d.radius, Math.min(width - d.radius, d.x));
        d.y = Math.max(d.radius, Math.min(height - d.radius, d.y));
      });
    })
    .alphaDecay(0.02)
    .velocityDecay(0.3);

  // Draw bubbles
  const bubbleGroups = svg.selectAll('g.bubble')
    .data(nodes)
    .join('g')
    .attr('class', 'bubble')
    .style('cursor', interactive ? 'pointer' : 'default');

  // Circle
  bubbleGroups.append('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => d.color)
    .attr('fill-opacity', 0.2)
    .attr('stroke', d => d.color)
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.6);

  // Text label
  bubbleGroups.append('text')
    .text(d => d.name)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('fill', '#F5F5F7')
    .attr('font-size', d => Math.max(9, d.radius * 0.38))
    .attr('font-family', "'Rubik', sans-serif")
    .attr('pointer-events', 'none')
    .each(function(d) {
      // Truncate text that doesn't fit
      const el = d3.select(this);
      const maxWidth = d.radius * 1.6;
      let text = d.name;
      while (el.node().getComputedTextLength() > maxWidth && text.length > 2) {
        text = text.slice(0, -1);
        el.text(text + '…');
      }
    });

  // Drag behavior (interactive mode)
  if (interactive) {
    bubbleGroups.call(
      d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

    // Click handler
    bubbleGroups.on('click', (event, d) => {
      event.stopPropagation();
      onTraitClick?.(d);
    });
  }

  // Tick — update positions
  simulation.on('tick', () => {
    bubbleGroups.attr('transform', d => `translate(${d.x}, ${d.y})`);
  });

  // Category legend
  const legend = svg.append('g')
    .attr('transform', `translate(12, ${height - categories.length * 20 - 8})`);

  categories.forEach((cat, i) => {
    const g = legend.append('g')
      .attr('transform', `translate(0, ${i * 20})`);

    g.append('circle')
      .attr('r', 5)
      .attr('cx', 5)
      .attr('cy', 0)
      .attr('fill', CATEGORY_COLORS[cat] || '#888')
      .attr('fill-opacity', 0.5);

    g.append('text')
      .attr('x', 16)
      .attr('y', 0)
      .attr('dominant-baseline', 'central')
      .attr('fill', '#9A9AA8')
      .attr('font-size', '0.7rem')
      .attr('font-family', "'Rubik', sans-serif")
      .text(CATEGORY_LABELS[cat] || cat);
  });

  // Entrance animation
  bubbleGroups
    .attr('opacity', 0)
    .transition()
    .duration(600)
    .delay((d, i) => i * 50)
    .attr('opacity', 1);

  return {
    update(newTraits) {
      // TODO: Animate trait updates in Phase 6
    },
    destroy() {
      simulation.stop();
      container.innerHTML = '';
    },
  };
}

/**
 * Render a comparison view: two sets of bubbles side-by-side
 * @param {HTMLElement} container
 * @param {Array} myTraits
 * @param {Array} theirTraits
 * @param {string} theirName
 */
export function renderComparison(container, myTraits, theirTraits, theirName) {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'bubble-comparison';
  const uid = Math.random().toString(36).slice(2, 8);
  wrapper.innerHTML = `
    <div class="bubble-col">
      <div class="bubble-col-label">אני</div>
      <div class="bubble-canvas" data-role="my-${uid}"></div>
    </div>
    <div class="bubble-divider"></div>
    <div class="bubble-col">
      <div class="bubble-col-label">${theirName || 'מועמד/ת'}</div>
      <div class="bubble-canvas" data-role="their-${uid}"></div>
    </div>
  `;
  container.appendChild(wrapper);

  const colWidth = (container.clientWidth - 32) / 2;
  const colHeight = container.clientHeight || 300;

  renderBubbles(wrapper.querySelector(`[data-role="my-${uid}"]`), myTraits, {
    width: colWidth, height: colHeight,
  });
  renderBubbles(wrapper.querySelector(`[data-role="their-${uid}"]`), theirTraits, {
    width: colWidth, height: colHeight,
  });
}

export { CATEGORY_COLORS, CATEGORY_LABELS };
