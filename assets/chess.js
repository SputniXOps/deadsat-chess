/*!
 * DeadSat Atlas — the board.
 * A monochrome, pixel-drawn 8x8 in the spirit of late-70s home computer chess.
 * Sprites are original 12x12 bitmaps. Canvas 2D, no dependencies.
 *
 * White = EU-01 (solid). Black = the satellite (outlined, dithered).
 * Two side boxes hold captured pieces. A cursor marks the queued move.
 */
(function (global) {
  'use strict';

  var SPR = {
    p: ['............',
        '....####....',
        '...######...',
        '...######...',
        '....####....',
        '.....##.....',
        '....####....',
        '...######...',
        '..########..',
        '.##########.',
        '.##########.',
        '............'],
    n: ['............',
        '....###.....',
        '...#####....',
        '..#######...',
        '.####.####..',
        '.###..###...',
        '.....####...',
        '....#####...',
        '...######...',
        '..########..',
        '.##########.',
        '............'],
    b: ['............',
        '.....##.....',
        '....####....',
        '...##.###...',
        '...######...',
        '....####....',
        '.....##.....',
        '....####....',
        '...######...',
        '..########..',
        '.##########.',
        '............'],
    r: ['............',
        '.##.####.##.',
        '.##########.',
        '..########..',
        '...######...',
        '...######...',
        '...######...',
        '...######...',
        '..########..',
        '.##########.',
        '.##########.',
        '............'],
    q: ['............',
        '.#..#..#..#.',
        '.##.##.##.#.',
        '.##########.',
        '..########..',
        '...######...',
        '...######...',
        '....####....',
        '...######...',
        '..########..',
        '.##########.',
        '............'],
    k: ['............',
        '.....##.....',
        '....####....',
        '.....##.....',
        '...######...',
        '..########..',
        '..########..',
        '...######...',
        '...######...',
        '..########..',
        '.##########.',
        '............']
  };
  var N = 12;       // sprite size in pixels
  var FILES = 'abcdefgh';

  function css(name, fb) { var v = getComputedStyle(document.documentElement).getPropertyValue(name); return (v && v.trim()) || fb; }

  /** Parse the piece placement field of a FEN string into a 64-entry array (a8 first). */
  function parseFen(fen) {
    var rows = fen.split(' ')[0].split('/'), out = [];
    for (var r = 0; r < 8; r++) {
      var row = rows[r] || '8';
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (ch >= '1' && ch <= '8') for (var k = 0; k < +ch; k++) out.push(null);
        else out.push({ t: ch.toLowerCase(), w: ch === ch.toUpperCase() });
      }
    }
    return out;
  }
  function sqIndex(sq) { return (8 - +sq[1]) * 8 + FILES.indexOf(sq[0]); }

  function create(canvas, opts) {
    var o = opts || {};
    var ctx = canvas.getContext('2d');
    var state = {
      fen: o.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      cursor: o.cursor || null,      // e.g. 'e4'
      from: o.from || null,          // e.g. 'e2'
      capturedByWhite: o.capturedByWhite || [],   // pieces taken from black
      capturedByBlack: o.capturedByBlack || [],
      labels: { top: o.labelTop || 'LO-19', bottom: o.labelBottom || 'EU-01' }
    };
    var C = {};
    function colors() {
      C = { bg: css('--ds-chess-bg', '#061109'), dark: css('--ds-chess-dark', '#0c2c13'), la: css('--ds-chess-light-a', '#1c7a2c'),
            lb: css('--ds-chess-light-b', '#145c21'), piece: css('--ds-chess-piece', '#8dff9c'), ink: css('--ds-chess-ink', '#66e87a'),
            dim: css('--ds-chess-dim', '#2f8a3f'), line: css('--ds-chess-line', '#1b4f25') };
    }
    colors();

    var S = 4;   // screen pixels per sprite pixel (recomputed on resize)
    var W, H, dpr = 1, boxW, boardX, boardY, sq;

    function layout() {
      var rect = canvas.getBoundingClientRect();
      var cw = Math.max(240, Math.round(rect.width));
      // sprite scale from the available width: board = 8 squares of 12 px + side column of 4 squares
      S = Math.max(2, Math.floor(cw / (N * 12.6)));
      sq = N * S;
      boxW = sq * 3.6;
      boardX = Math.round(boxW + S * 6);
      boardY = Math.round(S * 6);
      W = boardX + sq * 8 + S * 2;
      H = boardY + sq * 8 + S * 12;
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.aspectRatio = W + ' / ' + H;   // CSS keeps the proportions whatever the column width
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    }

    function px(x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); }

    function sprite(type, white, x0, y0, scale) {
      var s = scale || S, bm = SPR[type];
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        if (bm[y][x] !== '#') continue;
        if (white) { px(x0 + x * s, y0 + y * s, s, s, C.piece); continue; }
        // black: edge pixels solid, interior dithered
        var edge = y === 0 || x === 0 || y === N - 1 || x === N - 1 ||
                   bm[y - 1][x] !== '#' || bm[y + 1][x] !== '#' || bm[y][x - 1] !== '#' || bm[y][x + 1] !== '#';
        if (edge) px(x0 + x * s, y0 + y * s, s, s, C.piece);
        else if ((x + y) % 2 === 0) px(x0 + x * s, y0 + y * s, s, s, C.dim);
      }
    }

    function lightSquare(x, y) {
      // dither: two greens in a 1-px checker, the way a 1-bit display fakes a mid tone
      px(x, y, sq, sq, C.lb);
      ctx.fillStyle = C.la;
      for (var yy = 0; yy < N; yy++) for (var xx = 0; xx < N; xx++) if ((xx + yy) % 2 === 0) ctx.fillRect(x + xx * S, y + yy * S, S, S);
    }

    function box(x, y, w, h, list, title) {
      px(x, y, w, h, C.dark);
      ctx.strokeStyle = C.dim; ctx.lineWidth = Math.max(1, S / 2);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = C.ink; ctx.font = '500 ' + Math.max(9, S * 2.6) + 'px ' + css('--ds-font-mono', 'monospace'); ctx.textBaseline = 'top';
      ctx.fillText(title, x + S * 2, y + S * 1.5);
      var small = Math.max(1, Math.floor(S * 0.7)), perRow = Math.floor((w - S * 4) / (N * small + S));
      for (var i = 0; i < list.length; i++) {
        var cxp = x + S * 2 + (i % perRow) * (N * small + S), cyp = y + S * 5 + Math.floor(i / perRow) * (N * small + S);
        sprite(list[i].t, list[i].w, cxp, cyp, small);
      }
    }

    function draw() {
      px(0, 0, W, H, C.bg);
      var pieces = parseFen(state.fen);
      // board
      for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) {
        var x = boardX + f * sq, y = boardY + r * sq;
        if ((r + f) % 2 === 0) lightSquare(x, y); else px(x, y, sq, sq, C.dark);
      }
      ctx.strokeStyle = C.dim; ctx.lineWidth = Math.max(1, S / 2);
      ctx.strokeRect(boardX - S / 2, boardY - S / 2, sq * 8 + S, sq * 8 + S);
      // from-square marker and cursor
      if (state.from) { var fi = sqIndex(state.from); ctx.strokeStyle = C.piece; ctx.lineWidth = S / 2; ctx.strokeRect(boardX + (fi % 8) * sq + S, boardY + Math.floor(fi / 8) * sq + S, sq - S * 2, sq - S * 2); }
      if (state.cursor) {
        var ci = sqIndex(state.cursor), cxx = boardX + (ci % 8) * sq + sq / 2, cyy = boardY + Math.floor(ci / 8) * sq + sq / 2;
        ctx.fillStyle = C.piece;
        ctx.fillRect(cxx - S / 2, cyy - S * 3, S, S * 6); ctx.fillRect(cxx - S * 3, cyy - S / 2, S * 6, S);
      }
      // pieces
      for (var i = 0; i < 64; i++) if (pieces[i]) sprite(pieces[i].t, pieces[i].w, boardX + (i % 8) * sq, boardY + Math.floor(i / 8) * sq);
      // coordinates
      ctx.fillStyle = C.ink; ctx.font = '500 ' + Math.max(9, S * 2.6) + 'px ' + css('--ds-font-mono', 'monospace'); ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      for (var ff = 0; ff < 8; ff++) ctx.fillText(FILES[ff], boardX + ff * sq + sq / 2, boardY + sq * 8 + S * 2.5);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (var rr = 0; rr < 8; rr++) ctx.fillText(String(8 - rr), boardX - S * 2.5, boardY + rr * sq + sq / 2);
      ctx.textAlign = 'left';
      // side boxes
      var bh = sq * 3.2;
      box(S * 2, boardY, boxW - S * 2, bh, state.capturedByBlack, state.labels.top);
      box(S * 2, boardY + sq * 8 - bh, boxW - S * 2, bh, state.capturedByWhite, state.labels.bottom);
    }

    function render() { layout(); draw(); }
    render();
    global.addEventListener('resize', render);
    if (global.ResizeObserver) { var ro = new ResizeObserver(function () { render(); }); ro.observe(canvas.parentNode); }

    return {
      render: render,
      set: function (patch) { Object.keys(patch).forEach(function (k) { state[k] = patch[k]; }); draw(); },
      state: state,
      refreshTheme: function () { colors(); draw(); }
    };
  }

  global.DeadSatBoard = { create: create, parseFen: parseFen };
})(window);
