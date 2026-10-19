// NOVA (novelasligeras.net) · Tianshuge
//
// Standalone implementation in the LNReader plugin format. Replaces the
// previous official-script-plus-patch implementation. WooCommerce site:
//   - Popular and latest: the novel list page, in the order the reader picks.
//   - Search and filters: the same list page with a query and WooCommerce
//     taxonomies (category, estado, tipo, país).
//   - Novel: its product page, with the chapter list it embeds.
//   - Chapter: the product page's content block.
// Only public content is read: nothing that needs an account. The site asks
// for Cloudflare verification, which the reader's own browser handles; the
// extension makes normal requests and reports verification as an error.
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });

var fetchLib = require('@libs/fetch');
var FilterTypes = require('@libs/filterInputs').FilterTypes;
var NovelStatus = require('@libs/novelStatus').NovelStatus;
var defaultCover = require('@libs/defaultCover').defaultCover;
var cheerio = require('cheerio');

var SITE = 'https://novelasligeras.net/';

// The values below are the WooCommerce taxonomy keys the site's own list page
// uses (checked against the extension's list/search requests).
var ORDER_VALUES = {
  popularity: 'Popularidad',
  date: 'Últimas novedades',
  rating: 'Puntuación media'
};
var STATUS_VALUES = {
  '': 'Cualquier estado',
  '16': 'En Proceso',
  '407': 'Completado',
  '17': 'Pausado',
  '18': 'Cancelado'
};
var TYPE_VALUES = {
  '': 'Cualquier tipo',
  '23': 'Novela Ligera',
  '24': 'Novela Web'
};
var COUNTRY_VALUES = {
  '': 'Cualquier país',
  '21': 'Japón',
  '20': 'China',
  '22': 'Corea'
};

function absolute(path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (/^\/\//i.test(path)) return 'https:' + path;
  return SITE + String(path || '').replace(/^\/+/, '');
}

function relative(url) {
  return String(url || '').replace(
    /^https?:\/\/(www\.)?novelasligeras\.net(?=\/|$)/i,
    ''
  );
}

// Quita solo barras iniciales y el prefijo index.php/ para comparar. Nunca se
// usa como path devuelto: solo como clave de deduplicación (NVR-03).
function normalizePath(path) {
  return String(path || '')
    .replace(/^\/+/, '')
    .replace(/^index\.php\//i, '');
}

function isVerificationPage(html) {
  return /cf-browser-verification|cf_chl_opt|cf-please-wait|__cf_chl_|<title>\s*(?:just a moment|one moment, please|attention required|security verification|bot verification|ddos-guard|ingresando a nova)|id=["']challenge-stage["']|vb-challenge-form/i.test(html);
}

// Lanza si la respuesta no es 2xx o es una página de verificación: un error
// HTTP nunca se disfraza de ficha, lista o capítulo vacío (arregla NVA-02).
function text(url, init) {
  return fetchLib.fetchApi(url, init).then(function (response) {
    if (response.ok === false) throw new Error('http:' + response.status);
    return response.text().then(function (html) {
      if (isVerificationPage(html)) throw new Error('verificacion: la web pide abrir en el navegador');
      return html;
    });
  });
}

// La imagen más grande que ofrece la página, nunca el marcador de posición.
// El sitio carga las imágenes diferidas: la dirección real está en
// data-src / data-cfsrc, no necesariamente en src.
function cover(img) {
  var url = String(img.attr('data-src') || img.attr('data-cfsrc') || img.attr('src') || '').trim();
  if (!url || /^data:/i.test(url)) return '';
  return absolute(url);
}

// Cada obra una sola vez: se deduplica por ruta normalizada y se conserva el
// orden que entrega la web. Sólo tarjetas de producto (obras); ni enlaces de
// categoría, imagen ni paginación se confunden con fichas.
function list(html) {
  var $ = cheerio.load(html);
  var novels = [], seen = {};
  // Un solo contenedor de tarjeta. El selector compuesto anterior
  // (.dt-css-grid div.wf-cell, div.product, article.product) visitaba
  // contenedores anidados de una misma obra y la añadía más de una vez (NVA-01).
  $('.dt-css-grid div.wf-cell').each(function () {
    var item = $(this);
    var link = item.find('h4.entry-title a, h2.woocommerce-loop-product__title a, a.woocommerce-LoopProduct-link').first();
    if (!link.length) return;
    var name = link.text().replace(/\s+/g, ' ').trim();
    var path = relative(link.attr('href') || '');
    var key = normalizePath(path);
    if (!name || !key || seen[key]) return;
    // El path devuelto es el mismo que NOVA 1.1.2 entregaba (con o sin
    // index.php/ según el enlace de la web). La clave normalizada solo sirve
    // para no repetir la obra cuando la web expone ambas formas (NVR-03).
    if (key.indexOf('producto/') !== 0) return;
    seen[key] = true;
    novels.push({ name: name, path: path, cover: cover(item.find('img').first()) || defaultCover });
  });
  return novels;
}

function chosen(filters, key) {
  var value = filters && filters[key] && filters[key].value;
  return Array.isArray(value) ? value : [];
}

function statusFrom(value) {
  var s = String(value || '').toLowerCase();
  if (/ongoing|en curso|emisi/.test(s)) return NovelStatus.Ongoing;
  if (/complet|conclu|finaliz|terminad/.test(s)) return NovelStatus.Completed;
  if (/cancel/.test(s)) return NovelStatus.Cancelled;
  if (/hold|pausa|hiatus/.test(s)) return NovelStatus.OnHiatus;
  return NovelStatus.Unknown;
}

function Plugin() {
  this.id = 'nova';
  this.name = 'NOVA';
  this.site = SITE.replace(/\/$/, '');
  this.version = '1.1.4';
  this.icon = 'src/es/nova/icon.png';
  this.filters = {
    order: {
      type: FilterTypes.Picker, label: 'Ordenar por', value: 'date',
      options: [
        { label: 'Últimas novedades', value: 'date' },
        { label: 'Popularidad', value: 'popularity' },
        { label: 'Puntuación media', value: 'rating' }
      ]
    },
    category: {
      type: FilterTypes.Picker, label: 'Categoría', value: '',
      options: [
        { label: 'Todas las categorías', value: '' },
        { label: 'Acción', value: '40' },
        { label: 'Adulto', value: '53' },
        { label: 'Artes Marciales', value: '52' },
        { label: 'Aventura', value: '41' },
        { label: 'Ciencia Ficción', value: '59' },
        { label: 'Comedia', value: '43' },
        { label: 'Deportes', value: '68' },
        { label: 'Drama', value: '44' },
        { label: 'Ecchi', value: '45' },
        { label: 'Fantasía', value: '46' },
        { label: 'Gender Bender', value: '47' },
        { label: 'Harem', value: '48' },
        { label: 'Histórico', value: '49' },
        { label: 'Horror', value: '50' },
        { label: 'Josei', value: '51' },
        { label: 'Mechas', value: '54' },
        { label: 'Misterio', value: '55' },
        { label: 'Psicológico', value: '56' },
        { label: 'Recuentos de la Vida', value: '66' },
        { label: 'Romance', value: '57' },
        { label: 'Seinen', value: '60' },
        { label: 'Shojo', value: '62' },
        { label: 'Shojo Ai', value: '63' },
        { label: 'Shonen', value: '64' },
        { label: 'Smut', value: '67' },
        { label: 'Sobrenatural', value: '69' },
        { label: 'Tragedia', value: '70' },
        { label: 'Vida Escolar', value: '58' },
        { label: 'Xianxia', value: '72' },
        { label: 'Xuanhuan', value: '73' },
        { label: 'Yuri', value: '75' },
        { label: '+18', value: '15879' }
      ]
    },
    status: {
      type: FilterTypes.Picker, label: 'Estado', value: '',
      options: [
        { label: 'Cualquier estado', value: '' },
        { label: 'En Proceso', value: '16' },
        { label: 'Completado', value: '407' },
        { label: 'Pausado', value: '17' },
        { label: 'Cancelado', value: '18' }
      ]
    },
    type: {
      type: FilterTypes.Picker, label: 'Tipo', value: '',
      options: [
        { label: 'Cualquier tipo', value: '' },
        { label: 'Novela Ligera', value: '23' },
        { label: 'Novela Web', value: '24' }
      ]
    },
    country: {
      type: FilterTypes.Picker, label: 'País', value: '',
      options: [
        { label: 'Cualquier país', value: '' },
        { label: 'Japón', value: '21' },
        { label: 'China', value: '20' },
        { label: 'Corea', value: '22' }
      ]
    }
  };
}

Plugin.prototype.popularNovels = function (page, opts) {
  var filters = (opts && opts.filters) || this.filters;
  var order = (opts && opts.showLatestNovels) ? 'date'
    : ((filters.order && filters.order.value) || this.filters.order.value);
  var cat = (filters.category && filters.category.value) || '';
  var status = (filters.status && filters.status.value) || '';
  var type = (filters.type && filters.type.value) || '';
  var country = (filters.country && filters.country.value) || '';

  var parts = ['post_type=product', 'orderby=' + encodeURIComponent(order)];
  if (cat) parts.push('product-search-filter-product_cat=' + encodeURIComponent(cat));
  if (status) parts.push('product-search-filter-pa_estado=' + encodeURIComponent(status));
  if (type) parts.push('product-search-filter-pa_tipo=' + encodeURIComponent(type));
  if (country) parts.push('product-search-filter-pa_pais=' + encodeURIComponent(country));

  var base = page > 1 ? 'index.php/page/' + page + '/' : 'index.php/lista-de-novela-ligera-novela-web/';
  var url = SITE + base + '?' + parts.join('&');
  return text(url).then(list);
};

Plugin.prototype.searchNovels = function (term, page) {
  var q = encodeURIComponent(String(term || ''));
  var base = page > 1 ? 'index.php/page/' + page + '/' : 'index.php/lista-de-novela-ligera-novela-web/';
  // El formulario real usa sólo s: Shadow dio 9 resultados el 18/10/2026;
  // la consulta anterior con parámetros extra devolvió cero.
  var url = SITE + base + '?s=' + q;
  return text(url).then(list);
};

Plugin.prototype.parseNovel = function (novelPath) {
  var pageURL = absolute(novelPath);
  return text(pageURL).then(function (html) {
    var $ = cheerio.load(html);
    var name = $('h1').first().text().replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('La web cambió: no se encuentra el título de la obra');
    var coverURL = cover($('.woocommerce-product-gallery img').first());
    var author = $('.woocommerce-product-attributes-item--attribute_pa_escritor td').text().replace(/\s+/g, ' ').trim();
    var artist = $('.woocommerce-product-attributes-item--attribute_pa_ilustrador td').text().replace(/\s+/g, ' ').trim();
    var summaryEl = $('.woocommerce-product-details__short-description').first();
    summaryEl.find('script, style, noscript').remove();
    var summary = summaryEl.text().replace(/\s+/g, ' ').trim();
    var status = statusFrom($('.woocommerce-product-attributes-item--attribute_pa_estado td').text());

    var chapters = [], number = 0;
    // La ficha agrupa los capítulos por volumen; se devuelven en el orden en que
    // aparecen en la página (primero al último) y se numeran 1, 2, 3….
    $('.vc_row div.vc_column-inner > div.wpb_wrapper').each(function () {
      var block = $(this);
      var volume = block.find('.dt-fancy-title').first().text().replace(/\s+/g, ' ').trim();
      block.find('.wpb_tab a').each(function () {
        var a = $(this);
        var title = a.text().replace(/\s+/g, ' ').trim();
        var href = relative(a.attr('href') || '');
        if (!title || !href) return;
        number++;
        chapters.push({ name: volume ? volume + ' - ' + title : title, path: href,
          releaseTime: '', chapterNumber: number });
      });
    });

    return {
      path: novelPath, name: name, cover: coverURL || defaultCover,
      author: author, artist: artist, genres: '', status: status,
      summary: summary, chapters: chapters
    };
  });
};

Plugin.prototype.parseChapter = function (chapterPath) {
  return text(absolute(chapterPath)).then(function (html) {
    var $ = cheerio.load(html);
    var reading;
    if (/Nadie entra sin permiso/.test(html)) {
      reading = $('#content').first();
    } else {
      reading = $('.wpb_text_column.wpb_content_element > .wpb_wrapper').first();
    }
    if (!reading || !reading.length) reading = $('.entry-content, .reading-content').first();
    if (!reading || !reading.length) throw new Error('La web cambió: no se encuentra el texto del capítulo');
    // Una página de verificación o de capítulo bloqueado no se presenta como capítulo.
    if (reading.find('.content-blocked, .premium-block').length) {
      return '<p>This chapter is locked.</p><p>🔒 Capítulo de pago en la web: se desbloquea allí, o cuando la web lo libere.</p>';
    }
    reading.find('input, script, style, noscript, ins, iframe, form, button, .adsbygoogle, .code-block').remove();
    reading.find('img').each(function () {
      var image = $(this);
      var real = image.attr('data-src') || image.attr('data-cfsrc');
      if (real) image.attr('src', real);
      ['data-src', 'data-cfsrc', 'data-srcset', 'data-sizes', 'data-lazyloaded', 'srcset', 'sizes',
        'decoding', 'loading'].forEach(function (attribute) { image.removeAttr(attribute); });
      if (/^data:/.test(image.attr('src') || '')) image.remove();
    });
    var content = (reading.html() || '').trim();
    if (!content) throw new Error('El capítulo no tiene texto extraíble');
    return '<div class="chapter-content">' + content + '</div>';
  });
};

Plugin.prototype.resolveUrl = function (path) {
  return absolute(path);
};

exports.default = new Plugin();
