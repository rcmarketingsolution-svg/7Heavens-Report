# 7HEAVENS – Bestand & Überverkäufe

Dashboard mit tagesaktuellen Shopify-Daten. Eine GitHub Action holt jeden Morgen
Bestand, Verkäufe der letzten 30 Tage und offene Bestellungen aus Shopify,
**verschlüsselt** sie mit einem Passwort und veröffentlicht die Seite auf GitHub Pages.

Das Repository ist öffentlich, enthält aber keine Geschäftsdaten. Auf der Seite liegen
die Daten nur verschlüsselt (PBKDF2-SHA256 mit 600.000 Runden, AES-256-GCM); sie werden
erst im Browser mit dem Passwort entschlüsselt.

## Secrets

Unter *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Inhalt |
| --- | --- |
| `SHOPIFY_STORE` | z. B. `7heavens.myshopify.com` |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | App aus dem Shopify Dev Dashboard – **oder** stattdessen `SHOPIFY_TOKEN` (`shpat_…`) |
| `DASHBOARD_PASSWORD` | Passwort für die Seite, mindestens 12 Zeichen (besser 4–5 zufällige Wörter) |
| `LIEFERUNGEN_CSV` | Packlisten: `lieferschein,artikel,farbe,groesse,menge` |
| `SENDUNGEN_CSV` | Sendungen: `lieferschein,awb,kartons,flughafen,eta,ankunft,status` |

Die Shopify-App braucht Lesezugriff: `read_products`, `read_inventory`, `read_orders`, `read_reports`.

## Aktualisierung

- Täglich gegen 05:13 Uhr (Winterzeit) automatisch.
- Sofort: *Actions → Dashboard aktualisieren → Run workflow*.
- Neue Lieferung: Secrets `LIEFERUNGEN_CSV` / `SENDUNGEN_CSV` mit dem neuen Inhalt überschreiben, dann *Run workflow*.
- Passwort ändern: Secret `DASHBOARD_PASSWORD` ändern, dann *Run workflow*.

## Aufbau

- `site/index.html` – die Dashboard-Seite mit Passwortabfrage
- `site/dash.js` – entschlüsselt die Daten und rechnet Fehlbestand, Zulauf und Deckung
- `scripts/fetch-shopify.mjs` – holt die Shopify-Daten, verschlüsselt sie und baut die Seite nach `_site/`
- `.github/workflows/dashboard.yml` – täglicher Lauf und Veröffentlichung
