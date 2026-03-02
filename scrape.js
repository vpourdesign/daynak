/**
 * scrape.js — Récupère les propriétés de Dayna K sur RE/MAX Québec
 * et génère proprietes.html avec le même style visuel que index.html.
 *
 * Usage : node scrape.js
 * Lancé automatiquement par GitHub Actions chaque jour à 6h00 (heure de Montréal).
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const AGENT_URL = 'https://www.remax-quebec.com/fr/courtiers-immobiliers/dayna.k';
const DELAY_MS  = 2500; // pause entre chaque fiche pour ne pas surcharger

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── SCRAPE LISTE DES PROPRIÉTÉS ──────────────────────────────────────────────
async function scrapeListings(page) {
  console.log('→ Chargement de la page agent…');
  await page.goto(AGENT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  const listings = await page.evaluate(() => {
    const results = [];

    // RE/MAX Québec utilise des liens vers les fiches de propriétés
    const cards = document.querySelectorAll(
      'a[href*="/fr/proprietes/"], a[href*="/en/properties/"]'
    );

    const seen = new Set();
    cards.forEach(card => {
      const href = card.href;
      if (!href || seen.has(href)) return;

      // Filtrer uniquement les vraies fiches (pas les pages de recherche)
      if (!href.match(/\/proprietes\/[^?#]+\/[^?#]+-\d{6,}/)) return;

      seen.add(href);

      // Essayer de trouver image, prix, adresse dans la carte parente
      const container = card.closest('[class*="card"], [class*="listing"], [class*="property"], li, article') || card;

      const img     = container.querySelector('img');
      const priceEl = container.querySelector('[class*="price"], [class*="prix"]');
      const addrEl  = container.querySelector('[class*="address"], [class*="adresse"], [class*="location"]');
      const titleEl = container.querySelector('h2, h3, h4, [class*="title"], [class*="titre"]');

      results.push({
        url:     href,
        image:   img   ? img.src   : null,
        price:   priceEl ? priceEl.innerText.trim() : null,
        address: addrEl  ? addrEl.innerText.trim()  : null,
        title:   titleEl ? titleEl.innerText.trim()  : null,
      });
    });

    return results;
  });

  console.log(`  ${listings.length} propriété(s) trouvée(s)`);
  return listings;
}

// ─── SCRAPE DÉTAILS D'UNE FICHE ───────────────────────────────────────────────
async function scrapeDetail(page, listing) {
  console.log(`  → ${listing.url}`);
  try {
    await page.goto(listing.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);

    const detail = await page.evaluate(() => {
      const get = sel => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : null;
      };

      // Photo principale (la plus grande dispo)
      const mainImg =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('.carousel img, .slider img, .gallery img, [class*="photo"] img, [class*="image"] img')?.src ||
        null;

      // Toutes les photos de la galerie
      const photos = [...document.querySelectorAll(
        '.carousel img, .slider img, .gallery img, [class*="photo"] img, [class*="image"] img'
      )].map(i => i.src).filter(Boolean).slice(0, 8);

      // Prix
      const price =
        get('[class*="price"]') ||
        get('[class*="prix"]') ||
        get('[itemprop="price"]') ||
        document.querySelector('meta[property="og:description"]')?.content?.match(/[\d\s]+\s*\$/)?.[0] ||
        null;

      // Adresse
      const address =
        get('[class*="address"]') ||
        get('[class*="adresse"]') ||
        get('[itemprop="streetAddress"]') ||
        get('[class*="location"]') ||
        null;

      // Titre
      const title =
        get('h1') ||
        document.querySelector('meta[property="og:title"]')?.content ||
        null;

      // Description
      const description =
        get('[class*="description"] p, [class*="description"]') ||
        get('[class*="remarks"]') ||
        null;

      // Caractéristiques clés
      const rooms     = get('[class*="room"], [class*="piece"], [class*="bedroom"], [class*="chambre"]');
      const bathrooms = get('[class*="bath"], [class*="salle-de-bain"]');
      const area      = get('[class*="area"], [class*="superficie"]');
      const type      = get('[class*="type"], [class*="category"], [class*="categorie"]');
      const lotArea   = get('[class*="lot"], [class*="terrain"]');

      // Essayer de récupérer les specs depuis un tableau
      const specs = {};
      document.querySelectorAll(
        'table tr, [class*="feature"] li, [class*="spec"] li, [class*="detail"] li, dl dt'
      ).forEach(row => {
        const label = row.querySelector('th, dt, [class*="label"]')?.innerText?.trim();
        const value = row.querySelector('td, dd, [class*="value"]')?.innerText?.trim();
        if (label && value) specs[label] = value;
      });

      return {
        title, price, address, description,
        mainImg, photos,
        rooms, bathrooms, area, type, lotArea,
        specs,
      };
    });

    return { ...listing, ...detail };
  } catch (err) {
    console.error(`    Erreur sur ${listing.url}: ${err.message}`);
    return listing;
  }
}

// ─── GÉNÉRATION HTML ───────────────────────────────────────────────────────────
function formatPrice(raw) {
  if (!raw) return null;
  const match = raw.match(/[\d\s,]+/);
  if (!match) return raw;
  const num = parseInt(match[0].replace(/[\s,]/g, ''), 10);
  if (isNaN(num)) return raw;
  return num.toLocaleString('fr-CA') + ' $';
}

function propertyCard(prop, index) {
  const title   = prop.title   || prop.address || 'Propriété';
  const price   = formatPrice(prop.price) || '&mdash;';
  const address = prop.address || '';
  const image   = prop.mainImg || prop.image || '';
  const type    = prop.type    || '';
  const rooms   = prop.rooms || prop.specs?.['Chambres'] || prop.specs?.['Bedrooms'] || '';
  const baths   = prop.bathrooms || prop.specs?.['Salles de bain'] || prop.specs?.['Bathrooms'] || '';
  const area    = prop.area || prop.specs?.['Superficie habitable'] || prop.specs?.['Living area'] || '';
  const desc    = prop.description
    ? prop.description.replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 200) + (prop.description.length > 200 ? '…' : '')
    : '';

  const num = String(index + 1).padStart(2, '0');

  const tags = [type, rooms ? `${rooms} ch.` : null, baths ? `${baths} sdb` : null, area || null]
    .filter(Boolean)
    .map(t => `<span class="prop-tag">${t}</span>`)
    .join('');

  return `
  <article class="prop-card reveal">
    <a href="${prop.url}" target="_blank" rel="noopener noreferrer" class="prop-card-link">
      <div class="prop-card-image">
        ${image ? `<img src="${image}" alt="${title}" loading="lazy" />` : `<div class="prop-card-noimg"></div>`}
        <div class="prop-card-overlay"></div>
        <span class="prop-card-num">${num}</span>
      </div>
      <div class="prop-card-body">
        <div class="prop-card-top">
          <div class="prop-card-tags">${tags}</div>
          <p class="prop-card-price">${price}</p>
        </div>
        <h3 class="prop-card-title">${title}</h3>
        ${address ? `<p class="prop-card-address">${address}</p>` : ''}
        ${desc    ? `<p class="prop-card-desc">${desc}</p>` : ''}
        <span class="prop-card-cta">Voir la fiche &rarr;</span>
      </div>
    </a>
  </article>`;
}

function generateHTML(properties, updatedAt) {
  const cards    = properties.length > 0
    ? properties.map((p, i) => propertyCard(p, i)).join('\n')
    : `<div class="props-empty">
        <p>Aucune propriété active en ce moment.</p>
        <a href="https://www.remax-quebec.com/fr/courtiers-immobiliers/dayna.k" target="_blank" rel="noopener noreferrer" class="btn-sand" style="display:inline-block;margin-top:24px;">Voir sur RE/MAX →</a>
      </div>`;

  const count    = properties.length;
  const dateStr  = new Date(updatedAt).toLocaleDateString('fr-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mes propriétés — Dayna K, Courtière Immobilière RE/MAX Crystal</title>
  <meta name="description" content="Consultez toutes les propriétés actuellement listées par Dayna K, courtière immobilière sur la Rive-Nord de Montréal — RE/MAX Crystal." />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://daynak.ca/proprietes.html" />
  <meta property="og:title" content="Mes propriétés — Dayna K RE/MAX Crystal" />
  <meta property="og:description" content="Toutes les propriétés à vendre par Dayna K sur la Rive-Nord de Montréal." />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://daynak.ca/proprietes.html" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --cream:  #F5F0EA;
      --warm:   #E8DDD0;
      --sand:   #C89B7B;
      --brown:  #6B4A38;
      --dark:   #121110;
      --white:  #FFFFFF;
      --font-serif: 'Cormorant Garamond', Georgia, serif;
      --font-sans:  'DM Sans', sans-serif;
    }

    html { scroll-behavior: smooth; }
    body { font-family: var(--font-sans); color: var(--dark); background: var(--cream); overflow-x: hidden; }

    /* ─── NAV ─────────────────────────────────────────────────────── */
    nav {
      position: fixed; top: 0; left: 0; width: 100%; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
      padding: 22px 60px;
      background: rgba(245,240,234,0.92);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .nav-logo { display: flex; align-items: center; gap: 16px; }
    .nav-logo img { height: 34px; }
    .nav-logo .nav-logo-remax { height: 36px; }
    .nav-logo-remax-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
    .nav-logo-remax-label { font-family: var(--font-sans); font-size: 8px; font-weight: 400; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(0,0,0,0.38); }
    .nav-links { display: flex; gap: 36px; list-style: none; }
    .nav-links a {
      font-family: var(--font-sans); font-size: 13px; font-weight: 400;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--dark); text-decoration: none; transition: color 0.2s;
    }
    .nav-links a:hover, .nav-links a.active { color: var(--sand); }
    .nav-cta {
      background: var(--dark); color: var(--white);
      padding: 11px 26px; border: none; cursor: pointer;
      font-family: var(--font-sans); font-size: 12px; font-weight: 500;
      letter-spacing: 0.1em; text-transform: uppercase;
      text-decoration: none; transition: background 0.2s, color 0.2s;
    }
    .nav-cta:hover { background: var(--sand); }

    /* ─── BURGER ──────────────────────────────────────────────────── */
    .nav-burger {
      display: none; flex-direction: column; gap: 5px;
      background: none; border: none; cursor: pointer; padding: 4px;
    }
    .nav-burger span { display: block; width: 24px; height: 2px; background: var(--dark); transition: transform 0.3s, opacity 0.3s; }
    .nav-burger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
    .nav-burger.open span:nth-child(2) { opacity: 0; }
    .nav-burger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
    .nav-mobile-menu {
      display: none; flex-direction: column;
      position: fixed; top: 73px; left: 0; width: 100%;
      background: rgba(245,240,234,0.98); backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(0,0,0,0.08);
      z-index: 99; padding: 16px 0;
    }
    .nav-mobile-menu.open { display: flex; }
    .nav-mobile-menu a {
      padding: 14px 28px; font-size: 13px; font-weight: 500;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--dark); text-decoration: none;
      border-bottom: 1px solid rgba(0,0,0,0.05);
    }
    .nav-mobile-menu a.mobile-cta {
      margin: 12px 28px 4px; padding: 14px 28px;
      background: var(--dark); color: var(--white); text-align: center;
    }

    /* ─── HERO ────────────────────────────────────────────────────── */
    .page-hero {
      padding: 160px 80px 80px;
      background: var(--dark); color: var(--white);
      position: relative; overflow: hidden;
    }
    .page-hero::after {
      content: '';
      position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
      background: rgba(255,255,255,0.08);
    }
    .page-hero-eyebrow {
      font-size: 11px; font-weight: 500; letter-spacing: 0.2em;
      text-transform: uppercase; color: var(--sand); margin-bottom: 24px;
    }
    .page-hero-title {
      font-family: var(--font-serif); font-size: clamp(48px, 6vw, 80px);
      font-weight: 300; line-height: 1.05; margin-bottom: 20px;
    }
    .page-hero-title em { font-style: italic; color: var(--sand); }
    .page-hero-meta {
      font-size: 13px; color: rgba(255,255,255,0.45); margin-top: 32px;
      display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
    }
    .page-hero-meta span { display: flex; align-items: center; gap: 8px; }
    .page-hero-dot {
      width: 4px; height: 4px; border-radius: 50%;
      background: var(--sand); display: inline-block;
    }

    /* ─── PROPERTIES GRID ─────────────────────────────────────────── */
    .props-section {
      padding: 80px 80px 120px;
      background: var(--cream);
    }
    .props-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 2px;
    }
    .props-empty {
      grid-column: 1 / -1;
      text-align: center;
      padding: 80px 40px;
      font-size: 16px; color: #888;
    }

    /* ─── PROPERTY CARD ───────────────────────────────────────────── */
    .prop-card { background: var(--white); }
    .prop-card-link {
      display: block; text-decoration: none; color: inherit;
      transition: transform 0.3s;
    }
    .prop-card:hover .prop-card-link { transform: translateY(-4px); }
    .prop-card-image {
      position: relative; aspect-ratio: 4/3; overflow: hidden;
      background: var(--warm);
    }
    .prop-card-image img {
      width: 100%; height: 100%; object-fit: cover;
      transition: transform 0.6s ease;
    }
    .prop-card:hover .prop-card-image img { transform: scale(1.05); }
    .prop-card-noimg {
      width: 100%; height: 100%;
      background: linear-gradient(135deg, var(--warm), var(--sand));
      opacity: 0.4;
    }
    .prop-card-overlay {
      position: absolute; inset: 0;
      background: linear-gradient(to top, rgba(10,8,7,0.5) 0%, transparent 50%);
    }
    .prop-card-num {
      position: absolute; top: 20px; left: 20px;
      font-family: var(--font-serif); font-size: 13px; font-weight: 300;
      color: rgba(255,255,255,0.6); letter-spacing: 0.1em;
    }
    .prop-card-body { padding: 28px 32px 36px; }
    .prop-card-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; gap: 12px; }
    .prop-card-tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .prop-tag {
      font-size: 10px; font-weight: 500; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--sand);
      background: rgba(200,155,123,0.1);
      padding: 4px 10px;
    }
    .prop-card-price {
      font-family: var(--font-serif); font-size: 22px; font-weight: 400;
      color: var(--dark); white-space: nowrap;
    }
    .prop-card-title {
      font-family: var(--font-serif); font-size: 22px; font-weight: 300;
      line-height: 1.2; margin-bottom: 8px;
    }
    .prop-card-address {
      font-size: 13px; color: #888; margin-bottom: 12px; line-height: 1.5;
    }
    .prop-card-desc {
      font-size: 13px; line-height: 1.7; color: #666;
      margin-bottom: 20px; max-height: 4.2em; overflow: hidden;
    }
    .prop-card-cta {
      font-size: 11px; font-weight: 500; letter-spacing: 0.15em;
      text-transform: uppercase; color: var(--sand);
      display: inline-block; transition: letter-spacing 0.2s;
    }
    .prop-card:hover .prop-card-cta { letter-spacing: 0.22em; }

    /* ─── REVEAL ──────────────────────────────────────────────────── */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
    .reveal { opacity: 0; transform: translateY(24px); transition: opacity 0.6s ease, transform 0.6s ease; }
    .reveal.visible { opacity: 1; transform: translateY(0); }

    /* ─── FOOTER ──────────────────────────────────────────────────── */
    footer { background: var(--dark); color: rgba(255,255,255,0.5); }
    .footer-main {
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 32px;
      padding: 48px 80px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .footer-main img { height: 36px; opacity: 0.7; }
    .footer-compliance { font-size: 12px; line-height: 1.9; }
    .footer-broker-name { font-weight: 500; color: rgba(255,255,255,0.75); }
    .footer-compliance a { color: rgba(255,255,255,0.5); text-decoration: none; }
    .footer-links { display: flex; flex-direction: column; gap: 8px; }
    .footer-links a { font-size: 11px; letter-spacing: 0.06em; color: rgba(255,255,255,0.35); text-decoration: none; }
    .footer-links a:hover { color: var(--sand); }
    .footer-credit {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      padding: 20px 80px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
    }
    .footer-credit .vp-logo { height: 18px; opacity: 0.45; filter: invert(1); }

    /* ─── RESPONSIVE ──────────────────────────────────────────────── */
    @media (max-width: 900px) {
      nav { padding: 14px 20px; }
      .nav-links, .nav-cta { display: none; }
      .nav-burger { display: flex; }
      .page-hero { padding: 120px 28px 60px; }
      .props-section { padding: 48px 12px 80px; }
      .props-grid { grid-template-columns: 1fr; gap: 2px; }
      .footer-main { padding: 40px 28px; flex-direction: column; }
      .footer-credit { padding: 20px 28px; }
    }
    @media (max-width: 600px) {
      .prop-card-body { padding: 20px 20px 28px; }
    }
    @media (min-width: 901px) and (max-width: 1200px) {
      .props-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="nav-logo">
    <a href="index.html"><img src="https://static.wixstatic.com/media/623234_38d0a1ad40e8470493cc650fc46c9361~mv2.png" alt="Dayna K Logo" /></a>
    <div class="nav-logo-remax-wrap">
      <img src="https://static.wixstatic.com/media/623234_6395502c46a0448ea97d9111de1e7f3b~mv2.png" alt="RE/MAX Crystal" class="nav-logo-remax" />
      <span class="nav-logo-remax-label">Agence immobilière</span>
    </div>
  </div>
  <ul class="nav-links">
    <li><a href="index.html#services">Services</a></li>
    <li><a href="index.html#approche">Approche</a></li>
    <li><a href="index.html#secteurs">Secteurs</a></li>
    <li><a href="proprietes.html" class="active">Propriétés</a></li>
    <li><a href="index.html#temoignages">Témoignages</a></li>
    <li><a href="index.html#calculatrice">Calculatrice</a></li>
  </ul>
  <a href="index.html#contact" class="nav-cta">Me contacter</a>
  <button class="nav-burger" aria-label="Menu" onclick="toggleMenu()">
    <span></span><span></span><span></span>
  </button>
</nav>
<div class="nav-mobile-menu" id="navMobileMenu">
  <a href="index.html#services"    onclick="closeMenu()">Services</a>
  <a href="index.html#approche"    onclick="closeMenu()">Approche</a>
  <a href="index.html#secteurs"    onclick="closeMenu()">Secteurs</a>
  <a href="proprietes.html"        onclick="closeMenu()">Propriétés</a>
  <a href="index.html#temoignages" onclick="closeMenu()">Témoignages</a>
  <a href="index.html#calculatrice"onclick="closeMenu()">Calculatrice</a>
  <a href="index.html#contact" class="mobile-cta" onclick="closeMenu()">Me contacter</a>
</div>

<!-- HERO -->
<section class="page-hero">
  <p class="page-hero-eyebrow">RE/MAX Crystal · Rive-Nord de Montréal</p>
  <h1 class="page-hero-title">
    Mes<br>
    <em>propriétés.</em>
  </h1>
  <div class="page-hero-meta">
    <span><span class="page-hero-dot"></span> ${count} propriété${count !== 1 ? 's' : ''} active${count !== 1 ? 's' : ''}</span>
    <span>Mis à jour le ${dateStr}</span>
  </div>
</section>

<!-- GRILLE DE PROPRIÉTÉS -->
<section class="props-section">
  <div class="props-grid">
${cards}
  </div>
</section>

<!-- FOOTER -->
<footer>
  <div class="footer-main">
    <img src="https://static.wixstatic.com/media/623234_b20c3057e55146778c8ca566ddf2f52f~mv2.png" alt="Dayna K Logo Blanc" />
    <div class="footer-compliance">
      <p class="footer-broker-name">Dayna Kapogiannatos, courtier immobilier résidentiel</p>
      <p>RE/MAX Crystal, Agence immobilière</p>
      <p>228 boul. Labelle, Ste-Thérèse, Qc&nbsp; J7E 2X7</p>
      <p style="margin-top:4px;">
        <a href="tel:+14388827384">(438) 882-7384</a>
        &nbsp;·&nbsp;
        <a href="mailto:dayna.k@remax-quebec.com">dayna.k@remax-quebec.com</a>
      </p>
      <p style="margin-top:10px;">© ${new Date().getFullYear()} Dayna Kapogiannatos · RE/MAX Crystal · Tous droits réservés</p>
    </div>
    <div class="footer-links">
      <a href="#">Politique de confidentialité</a>
      <a href="#">Conditions d'utilisation</a>
    </div>
  </div>
  <div class="footer-credit">
    <span>Stratégie web</span>
    <a href="https://www.vpourdesign.com" target="_blank" rel="noopener noreferrer"><img class="vp-logo" src="logo-vpourdesign.png" alt="vpourdesign" /></a>
  </div>
</footer>

<script>
  // Scroll reveal
  const reveals = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => entry.target.classList.add('visible'), i * 80);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });
  reveals.forEach(el => observer.observe(el));

  function toggleMenu() {
    document.getElementById('navMobileMenu').classList.toggle('open');
    document.querySelector('.nav-burger').classList.toggle('open');
  }
  function closeMenu() {
    document.getElementById('navMobileMenu').classList.remove('open');
    document.querySelector('.nav-burger').classList.remove('open');
  }
  document.addEventListener('click', function(e) {
    const menu   = document.getElementById('navMobileMenu');
    const burger = document.querySelector('.nav-burger');
    if (menu.classList.contains('open') && !menu.contains(e.target) && !burger.contains(e.target)) {
      menu.classList.remove('open');
      burger.classList.remove('open');
    }
  });
</script>
</body>
</html>`;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Scraper Dayna K — RE/MAX Québec ===');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();

    // User-Agent proche d'un vrai navigateur
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1440, height: 900 });

    // ── 1. Récupérer la liste ──────────────────────────────────────
    const listings = await scrapeListings(page);

    if (listings.length === 0) {
      console.warn('⚠️  Aucune propriété trouvée. Vérifier les sélecteurs CSS de RE/MAX Québec.');
    }

    // ── 2. Enrichir chaque fiche ───────────────────────────────────
    const properties = [];
    for (const listing of listings) {
      const detail = await scrapeDetail(page, listing);
      properties.push(detail);
      await sleep(DELAY_MS);
    }

    // ── 3. Générer proprietes.html ─────────────────────────────────
    const updatedAt = new Date().toISOString();
    const html      = generateHTML(properties, updatedAt);
    const outPath   = path.join(__dirname, 'proprietes.html');
    fs.writeFileSync(outPath, html, 'utf-8');

    console.log(`\n✓ proprietes.html généré (${properties.length} propriété(s)) — ${updatedAt}`);
  } finally {
    await browser.close();
  }
})();
