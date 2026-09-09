/*
 * AudioPlayer — player de áudio customizado com waveform contínua (SVG).
 *
 * Uso:
 *   <div class="audio-player"
 *        data-audio-src="audio/apresentacao.mp3"
 *        data-audio-title="Um pouco sobre mim"
 *        data-audio-tag="Mensagem em áudio"></div>
 *   <script src="js/audio-player.js"></script>
 *
 * Qualquer elemento com [data-audio-src] é inicializado automaticamente ao
 * carregar a página. Também pode ser instanciado manualmente:
 *   new AudioPlayer(document.querySelector('#meu-player'));
 *
 * JS puro, sem depender de jQuery nem de nenhum framework.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var VIEW_W = 1000;
  var VIEW_H = 100;
  var CENTER_Y = VIEW_H / 2;
  var MAX_AMP = VIEW_H / 2 - 4;
  var MIN_AMP_FRACTION = 0.22;
  var POINT_COUNT = 90;

  // garante que só um player toque por vez na página
  var activePlayer = null;
  var sharedAudioCtx = null;

  function getAudioContext() {
    if (sharedAudioCtx) return sharedAudioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedAudioCtx = new Ctx();
    return sharedAudioCtx;
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // waveform "de mentirinha", determinística a partir da URL do áudio.
  // usada enquanto o waveform real ainda não foi decodificado (ou quando
  // não é possível decodificar por CORS/formato) — assim o player nunca
  // fica com uma linha reta/sem graça.
  function seededPeaks(seed, count) {
    var hash = 0;
    for (var i = 0; i < seed.length; i++) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    var peaks = [];
    for (var j = 0; j < count; j++) {
      hash = (hash * 9301 + 49297) % 233280;
      peaks.push(0.35 + (hash / 233280) * 0.65);
    }
    return peaks;
  }

  // converte os picos de amplitude (0..1) em pontos x/y alternando o sinal,
  // o que produz a "onda" contínua característica de players de voz/música.
  function buildPoints(peaks) {
    var n = peaks.length;
    var stepX = VIEW_W / (n - 1);
    return peaks.map(function (peak, i) {
      var clamped = Math.max(0, Math.min(1, peak));
      // levanta um pouco os trechos mais quietos do áudio (para a onda
      // nunca ficar quase reta), mas preserva a variação entre picos
      // altos e baixos — é essa variação que dá o efeito "orgânico" da
      // referência, em vez de uma onda uniforme demais.
      var boosted = Math.pow(clamped, 0.65);
      var amp = (MIN_AMP_FRACTION + (1 - MIN_AMP_FRACTION) * boosted) * MAX_AMP;
      var sign = i % 2 === 0 ? -1 : 1;
      return { x: i * stepX, y: CENTER_Y + sign * amp };
    });
  }

  // Catmull-Rom -> Bézier: transforma os pontos numa curva suave (em vez de
  // um polígono anguloso), como uma linha de waveform desenhada à mão.
  function smoothPath(points) {
    if (!points.length) return '';
    if (points.length === 1) {
      return 'M' + points[0].x.toFixed(2) + ',' + points[0].y.toFixed(2);
    }
    var d = 'M' + points[0].x.toFixed(2) + ',' + points[0].y.toFixed(2) + ' ';
    for (var i = 0; i < points.length - 1; i++) {
      var p0 = points[i === 0 ? i : i - 1];
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = points[i + 2 < points.length ? i + 2 : i + 1];
      var cp1x = p1.x + (p2.x - p0.x) / 6;
      var cp1y = p1.y + (p2.y - p0.y) / 6;
      var cp2x = p2.x - (p3.x - p1.x) / 6;
      var cp2y = p2.y - (p3.y - p1.y) / 6;
      d += 'C' + cp1x.toFixed(2) + ',' + cp1y.toFixed(2) + ' ' +
                  cp2x.toFixed(2) + ',' + cp2y.toFixed(2) + ' ' +
                  p2.x.toFixed(2) + ',' + p2.y.toFixed(2) + ' ';
    }
    return d;
  }

  // separa os pontos em "já tocado" / "restante" numa fração exata (0..1),
  // interpolando um ponto de fronteira para as duas curvas se encontrarem
  // sem costura visível.
  function splitAtFraction(points, fraction) {
    if (fraction <= 0) return { played: [points[0]], remaining: points.slice() };
    if (fraction >= 1) return { played: points.slice(), remaining: [points[points.length - 1]] };

    var targetX = fraction * VIEW_W;
    var idx = 0;
    while (idx < points.length - 1 && points[idx + 1].x < targetX) idx++;
    var a = points[idx];
    var b = points[idx + 1] || a;
    var t = b.x === a.x ? 0 : (targetX - a.x) / (b.x - a.x);
    var boundary = { x: targetX, y: a.y + (b.y - a.y) * t };

    return {
      played: points.slice(0, idx + 1).concat([boundary]),
      remaining: [boundary].concat(points.slice(idx + 1))
    };
  }

  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  function AudioPlayer(el) {
    this.el = el;
    this.src = el.getAttribute('data-audio-src') || '';
    this.title = el.getAttribute('data-audio-title') || 'Áudio';
    this.tag = el.getAttribute('data-audio-tag') || 'Mensagem em áudio';
    this.autoplay = el.getAttribute('data-audio-autoplay') === 'true';
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.points = [];
    this.decodedBuffer = null;

    this._build();
    this._bindEvents();

    if (this.src) {
      this.audio.src = this.src;
      this._setWave(seededPeaks(this.src, POINT_COUNT));
      this._setState('loading', 'Carregando áudio…');
      this._loadRealWaveform();
      if (this.autoplay) this._attemptAutoplay();
    } else {
      this._setState('error', 'Nenhum áudio informado.');
    }
  }

  AudioPlayer.instances = [];

  AudioPlayer.prototype._build = function () {
    this.el.classList.add('audio-player');
    if (!this.el.hasAttribute('role')) this.el.setAttribute('role', 'group');
    if (!this.el.getAttribute('aria-label')) this.el.setAttribute('aria-label', 'Player de áudio: ' + this.title);

    this.el.innerHTML =
      '<div class="audio-player__tag"><span class="audio-player__dot" aria-hidden="true"></span><span></span></div>' +
      '<div class="audio-player__header">' +
        '<button type="button" class="audio-player__toggle" aria-label="Reproduzir áudio" aria-pressed="false">' +
          '<span class="audio-player__icon audio-player__icon--play">' + ICON_PLAY + '</span>' +
          '<span class="audio-player__icon audio-player__icon--pause">' + ICON_PAUSE + '</span>' +
        '</button>' +
        '<div class="audio-player__title"></div>' +
        '<div class="audio-player__time"><span class="audio-player__current">0:00</span><span class="audio-player__sep">/</span><span class="audio-player__duration">0:00</span></div>' +
      '</div>' +
      '<div class="audio-player__waveform" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<svg class="audio-player__svg" viewBox="0 0 ' + VIEW_W + ' ' + VIEW_H + '" preserveAspectRatio="none">' +
          '<path class="audio-player__wave audio-player__wave--remaining"></path>' +
          '<path class="audio-player__wave audio-player__wave--played"></path>' +
        '</svg>' +
      '</div>' +
      '<span class="audio-player__status" aria-live="polite"></span>';

    this.tagTextEl = this.el.querySelector('.audio-player__tag span:last-child');
    this.tagTextEl.textContent = this.tag;
    this.el.querySelector('.audio-player__title').textContent = this.title;
    this.el.querySelector('.audio-player__title').setAttribute('title', this.title);

    this.toggleBtn = this.el.querySelector('.audio-player__toggle');
    this.waveform = this.el.querySelector('.audio-player__waveform');
    this.playedPath = this.el.querySelector('.audio-player__wave--played');
    this.remainingPath = this.el.querySelector('.audio-player__wave--remaining');
    this.currentEl = this.el.querySelector('.audio-player__current');
    this.durationEl = this.el.querySelector('.audio-player__duration');
    this.status = this.el.querySelector('.audio-player__status');

    this.waveform.setAttribute('aria-label', 'Progresso do áudio, use as setas do teclado para avançar ou voltar');
  };

  AudioPlayer.prototype._setWave = function (peaks) {
    this.points = buildPoints(peaks);
    this._updateProgress();
  };

  AudioPlayer.prototype._setState = function (state, message) {
    this.el.classList.remove('is-loading', 'is-error');
    if (state) this.el.classList.add('is-' + state);
    this.status.textContent = message || '';
    var disabled = state === 'loading' || state === 'error';
    this.toggleBtn.disabled = disabled;
    this.waveform.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    this.waveform.setAttribute('tabindex', disabled ? '-1' : '0');
  };

  // tenta decodificar o áudio de verdade via Web Audio API para desenhar o
  // waveform real. se falhar (CORS, formato não suportado, offline...) o
  // player continua funcionando normalmente com o waveform "seeded".
  AudioPlayer.prototype._loadRealWaveform = function () {
    var self = this;
    var ctx = getAudioContext();
    if (!ctx || !window.fetch) return;

    fetch(this.src)
      .then(function (res) {
        if (!res.ok) throw new Error('network-error');
        return res.arrayBuffer();
      })
      .then(function (buffer) {
        return ctx.decodeAudioData(buffer);
      })
      .then(function (audioBuffer) {
        self.decodedBuffer = audioBuffer;
        self._setWave(self._extractPeaks(audioBuffer, POINT_COUNT));
      })
      .catch(function () {
        // mantém o waveform seeded já renderizado — sem quebrar a UI
      });
  };

  AudioPlayer.prototype._extractPeaks = function (audioBuffer, count) {
    var data = audioBuffer.getChannelData(0);
    var blockSize = Math.max(1, Math.floor(data.length / count));
    var peaks = [];
    for (var i = 0; i < count; i++) {
      var start = i * blockSize;
      var sum = 0;
      for (var j = 0; j < blockSize; j++) {
        var v = data[start + j] || 0;
        sum += v * v;
      }
      peaks.push(Math.sqrt(sum / blockSize));
    }
    var max = Math.max.apply(null, peaks) || 1;
    return peaks.map(function (p) { return p / max; });
  };

  AudioPlayer.prototype.play = function () {
    var self = this;
    if (this.toggleBtn.disabled) return;
    var playPromise = this.audio.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(function () {
        self.el.classList.remove('needs-tap');
        self.tagTextEl.textContent = self.tag;
        self._setState('error', 'Não foi possível reproduzir o áudio.');
      });
    }
  };

  AudioPlayer.prototype.pause = function () {
    this.audio.pause();
  };

  // tenta iniciar sozinho ao carregar a página. a maioria dos navegadores
  // (Chrome, Firefox, Safari) bloqueia áudio com som sem alguma interação
  // prévia do visitante com o site — isso é política do navegador, não dá
  // pra forçar via código. por isso a falha aqui é silenciosa: se o
  // navegador bloquear, o player entra em "needs-tap" (pulsa o botão e
  // troca a legenda por um convite pra tocar), sem mostrar nenhum erro
  // (afinal não é um problema real).
  AudioPlayer.prototype._attemptAutoplay = function () {
    var self = this;
    var playPromise = this.audio.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(function () {
        self.el.classList.add('needs-tap');
        self.tagTextEl.textContent = 'Toque para ouvir';
      });
    }
  };

  AudioPlayer.prototype._updateProgress = function () {
    if (!this.points.length) return;
    var duration = this.audio.duration;
    var current = this.audio.currentTime;
    var fraction = isFinite(duration) && duration > 0 ? current / duration : 0;

    this.currentEl.textContent = formatTime(current);
    if (isFinite(duration)) this.durationEl.textContent = formatTime(duration);

    var split = splitAtFraction(this.points, fraction);
    this.playedPath.setAttribute('d', smoothPath(split.played));
    this.remainingPath.setAttribute('d', smoothPath(split.remaining));

    this.waveform.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    this.waveform.setAttribute('aria-valuetext', formatTime(current) + ' de ' + formatTime(duration));
  };

  AudioPlayer.prototype._seekFromClientX = function (clientX) {
    if (!isFinite(this.audio.duration) || this.toggleBtn.disabled) return;
    var rect = this.waveform.getBoundingClientRect();
    var fraction = rect.width ? (clientX - rect.left) / rect.width : 0;
    fraction = Math.max(0, Math.min(1, fraction));
    this.audio.currentTime = fraction * this.audio.duration;
    this._updateProgress();
  };

  AudioPlayer.prototype._bindEvents = function () {
    var self = this;

    this.toggleBtn.addEventListener('click', function () {
      if (self.audio.paused) self.play();
      else self.pause();
    });

    this.audio.addEventListener('loadedmetadata', function () {
      self.durationEl.textContent = formatTime(self.audio.duration);
      self._setState(null, '');
      self._updateProgress();
    });

    this.audio.addEventListener('timeupdate', function () {
      self._updateProgress();
    });

    this.audio.addEventListener('play', function () {
      self.el.classList.add('is-playing');
      self.toggleBtn.setAttribute('aria-label', 'Pausar áudio');
      self.toggleBtn.setAttribute('aria-pressed', 'true');
      if (self.el.classList.contains('needs-tap')) {
        self.el.classList.remove('needs-tap');
        self.tagTextEl.textContent = self.tag;
      }
      if (activePlayer && activePlayer !== self) activePlayer.pause();
      activePlayer = self;
    });

    this.audio.addEventListener('pause', function () {
      self.el.classList.remove('is-playing');
      self.toggleBtn.setAttribute('aria-label', 'Reproduzir áudio');
      self.toggleBtn.setAttribute('aria-pressed', 'false');
    });

    this.audio.addEventListener('ended', function () {
      self.audio.currentTime = 0;
      self._updateProgress();
    });

    this.audio.addEventListener('error', function () {
      self._setState('error', 'Áudio indisponível no momento.');
    });

    this.waveform.addEventListener('click', function (evt) {
      self._seekFromClientX(evt.clientX);
    });

    this.waveform.addEventListener('touchstart', function (evt) {
      if (evt.touches && evt.touches[0]) self._seekFromClientX(evt.touches[0].clientX);
    }, { passive: true });

    this.waveform.addEventListener('keydown', function (evt) {
      if (self.toggleBtn.disabled || !isFinite(self.audio.duration)) return;
      var step = 5;
      switch (evt.key) {
        case 'ArrowRight':
          self.audio.currentTime = Math.min(self.audio.duration, self.audio.currentTime + step);
          break;
        case 'ArrowLeft':
          self.audio.currentTime = Math.max(0, self.audio.currentTime - step);
          break;
        case 'Home':
          self.audio.currentTime = 0;
          break;
        case 'End':
          self.audio.currentTime = self.audio.duration;
          break;
        case ' ':
        case 'Spacebar':
        case 'Enter':
          evt.preventDefault();
          if (self.audio.paused) self.play(); else self.pause();
          return;
        default:
          return;
      }
      evt.preventDefault();
      self._updateProgress();
    });
  };

  AudioPlayer.prototype.destroy = function () {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.el.innerHTML = '';
    this.el.classList.remove('audio-player', 'is-loading', 'is-error', 'is-playing');
    if (activePlayer === this) activePlayer = null;
    var idx = AudioPlayer.instances.indexOf(this);
    if (idx > -1) AudioPlayer.instances.splice(idx, 1);
  };

  function init() {
    var els = document.querySelectorAll('.audio-player[data-audio-src]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__audioPlayerInstance) continue;
      var instance = new AudioPlayer(el);
      el.__audioPlayerInstance = instance;
      AudioPlayer.instances.push(instance);
    }
  }

  // quando o usuário dá play e depois navega para outra página, o navegador
  // pode guardar esta página no bfcache (cache de navegação) com o áudio
  // tocando. ao voltar com o botão "voltar", a página é restaurada do jeito
  // que estava — inclusive o som — sem o nosso código rodar de novo. para
  // evitar esse "autoplay surpresa", pausamos tudo ao entrar no bfcache.
  window.addEventListener('pagehide', function (evt) {
    if (!evt.persisted) return;
    AudioPlayer.instances.forEach(function (instance) {
      instance.pause();
    });
  });

  // botões externos (ex.: ícone no navbar) que ligam/desligam um player
  // pelo seletor em [data-audio-toggle-for], mantendo o ícone sincronizado
  // com o estado real do áudio (inclusive quando o play/pause acontece
  // pelo próprio player, não pelo botão do navbar).
  function initExternalToggles() {
    var toggles = document.querySelectorAll('[data-audio-toggle-for]');
    for (var i = 0; i < toggles.length; i++) {
      wireExternalToggle(toggles[i]);
    }
  }

  function wireExternalToggle(btn) {
    var selector = btn.getAttribute('data-audio-toggle-for');
    var targetEl = selector ? document.querySelector(selector) : document.querySelector('.audio-player');
    var instance = targetEl && targetEl.__audioPlayerInstance;
    if (!instance) return;

    btn.classList.add('nav-audio-toggle');
    btn.innerHTML =
      '<span class="nav-audio-toggle__icon nav-audio-toggle__icon--play">' + ICON_PLAY + '</span>' +
      '<span class="nav-audio-toggle__icon nav-audio-toggle__icon--pause">' + ICON_PAUSE + '</span>';

    function sync() {
      var playing = !instance.audio.paused;
      btn.classList.toggle('is-playing', playing);
      btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      btn.setAttribute('aria-label', playing ? 'Pausar áudio de apresentação' : 'Reproduzir áudio de apresentação');
      btn.disabled = instance.toggleBtn.disabled;
    }

    btn.addEventListener('click', function () {
      if (instance.audio.paused) instance.play(); else instance.pause();
    });

    instance.audio.addEventListener('play', sync);
    instance.audio.addEventListener('pause', sync);
    instance.audio.addEventListener('ended', sync);
    instance.audio.addEventListener('error', sync);
    instance.audio.addEventListener('loadedmetadata', sync);
    sync();
  }

  function initAll() {
    init();
    initExternalToggles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  window.AudioPlayer = AudioPlayer;
})();
