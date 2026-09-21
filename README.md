# bank-scraper-service

שרת Express (Node 20) שעוטף את הספרייה [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)
וחושף חמישה ראוטים מאובטחים ב-API key. מיועד לפריסה על Railway בתוך Docker.

## משתני סביבה

| משתנה | חובה | תיאור |
| --- | --- | --- |
| `SCRAPER_API_KEY` | כן | כל בקשה חייבת לשלוח את הערך הזה בכותרת `X-API-Key`. חוסר התאמה מחזיר 401. |
| `ENCRYPTION_KEY` | כן | מפתח AES-256-GCM באורך 32 בייט, כ-64 תווי hex או כ-base64. יצירה: `openssl rand -hex 32`. |
| `PORT` | לא | Railway מזריק אותו אוטומטית. ברירת מחדל 3000. |
| `DATA_DIR` | לא | ספריית הנתונים. ברירת מחדל `/data`, כלומר ה-Volume. |
| `PUPPETEER_EXECUTABLE_PATH` | לא | נקבע ב-Dockerfile ל-`/usr/bin/chromium`. |

השרת נכשל מיד בעלייה אם `SCRAPER_API_KEY` או `ENCRYPTION_KEY` חסרים או שהמפתח אינו באורך הנכון,
כדי שלא תתגלה בעיית תצורה רק בבקשה הראשונה.

## פריסה ב-Railway

1. חיבור הריפו כ-service מסוג Dockerfile (ה-Dockerfile מתקין chromium דרך apt ומדלג על ההורדה של puppeteer).
2. הגדרת המשתנים `SCRAPER_API_KEY` ו-`ENCRYPTION_KEY` בלשונית Variables. את `PORT` אין צורך להגדיר.
3. חיבור Volume ל-Mount Path `/data`. שם נשמר `connections.json` עם ה-credentials המוצפנים;
   בלי Volume כל החיבורים יימחקו בכל דיפלוי.
4. הגדרת לפחות 1GB RAM — chromium צורך זיכרון בזמן סקרייפינג.
5. **מופע יחיד, ללא autoscale ו-`numReplicas: 1`.** סשני ה-OTP מוחזקים בזיכרון בלבד (כולל אובייקט
   הסקרייפר והדפדפן הפתוח), וגם נעילת הסנכרון היא נעילה בתוך התהליך. ריבוי מופעים היה מנתב את
   `POST /otp` למופע שלא מחזיק את הסשן, ומאפשר שני סנכרונים מקבילים לאותו חיבור.

### הרצה מקומית

```bash
npm ci
SCRAPER_API_KEY=dev-key ENCRYPTION_KEY=$(openssl rand -hex 32) DATA_DIR=./data npm start
npm test   # בדיקות עם סקרייפר מדומה, בלי דפדפן אמיתי
```

## חוזה ה-API

כל הראוטים דורשים `X-API-Key`. תשובת שגיאה היא תמיד `{ ok: false, error_code }` כאשר `error_code`
הוא אחד מ-`invalid_credentials`, `otp_required`, `blocked`, `timeout`, `service_unavailable`, `unknown`.

```
GET  /health      → { ok: true, providers: [...] }
POST /connect     ← { provider, credentials }        → { ok: true, connection_id }
                                                     או { ok: true, requires_otp: true, session_id }
POST /otp         ← { session_id, otp_code }         → { ok: true, connection_id }
POST /sync        ← { connection_id, since }         → { ok: true, balance, currency, transactions: [] }
POST /disconnect  ← { connection_id }                → { ok: true }
```

ספקים נתמכים: `leumi`, `hapoalim`, `discount`, `mizrahi`, `otsarHahayal`, `beinleumi`, `massad`,
`yahav`, `isracard`, `amex`, `visaCal`, `max`, `behatsdaa`.

השדות ב-`credentials` הם אלה שהספרייה מצפה להם לאותו ספק (למשל `username`+`password` בלאומי,
`id`+`card6Digits`+`password` בישראכרט). הם עוברים כמו שהם.

מבנה טרנזקציה — בדיוק שבעה שדות:

```json
{
  "external_id": "777",
  "date": "2026-09-01T00:00:00.000Z",
  "charge_date": "2026-09-03T00:00:00.000Z",
  "description": "סופר",
  "amount": -50,
  "currency": "ILS",
  "is_pending": false
}
```

### קודי HTTP

| מצב | קוד | `error_code` |
| --- | --- | --- |
| `X-API-Key` חסר או שגוי | 401 | `invalid_credentials` |
| קלט לא תקין (ספק לא נתמך, `credentials` חסרים, `connection_id` חסר) | 400 | `invalid_credentials` |
| פרטי התחברות שגויים או דרישה להחלפת סיסמה | 400 | `invalid_credentials` |
| הספק דורש OTP ואין דרך לספק אותו | 400 | `otp_required` |
| חשבון חסום | 403 | `blocked` |
| סקרייפינג מעל 110 שניות | 504 | `timeout` |
| כשל בהרמת הדפדפן או בעיית רשת | 503 | `service_unavailable` |
| סנכרון מקביל לאותו `connection_id` | 409 | `service_unavailable` |
| `connection_id` לא קיים | 404 | `unknown` |
| סשן OTP שפג או לא קיים, JSON לא תקין, שגיאה לא מזוהה | 400 / 500 | `unknown` |

`POST /disconnect` הוא אידמפוטנטי: הוא מחזיר `{ ok: true }` גם אם החיבור כבר נמחק.

## מיפוי מהספרייה

אומת מול **israeli-bank-scrapers 6.12.1** המותקנת בפועל (`lib/transactions.d.ts`, `lib/scrapers/errors.d.ts`):

| השדה בשירות | השדה בספרייה |
| --- | --- |
| `external_id` | `identifier` (מומר למחרוזת) |
| `date` | `date` |
| `charge_date` | `processedDate`, ובהיעדרו `date` |
| `description` | `description` |
| `amount` | `chargedAmount` |
| `currency` | `chargedCurrency`, ובהיעדרו `originalCurrency`, אחר כך מטבע החשבון, אחרת `ILS` |
| `is_pending` | `status === 'pending'` |

`identifier` הוא שדה אופציונלי בספרייה. כשהוא חסר נגזר `external_id` יציב מ-sha1 של
provider, תאריך, תיאור וסכום; טרנזקציות זהות לחלוטין מקבלות סיומת `#2`, `#3` וכן הלאה
כדי שיישארו נפרדות.

`balance` הוא סכום ה-`balance` של כל החשבונות שמדווחים יתרה, ו-`null` כשאף חשבון לא מדווח
(מקרה רגיל בחברות כרטיסי אשראי). `currency` נלקח מהחשבון הראשון שמדווח מטבע.

מיפוי ה-`errorType` של הספרייה (`success: false` ממופה, לא נזרק):

| `errorType` | `error_code` |
| --- | --- |
| `INVALID_PASSWORD` | `invalid_credentials` |
| `CHANGE_PASSWORD` | `invalid_credentials` |
| `TWO_FACTOR_RETRIEVER_MISSING` | `otp_required` |
| `ACCOUNT_BLOCKED` | `blocked` |
| `TIMEOUT` | `timeout` |
| `GENERIC`, `GENERAL_ERROR`, וכל ערך לא מוכר | `unknown` |

## זרימת OTP

בגרסה 6.12.1 רק סקרייפר אחד בספרייה (`oneZero`) מממש בפועל את
`triggerTwoFactorAuth` / `getLongTermTwoFactorToken`; בכל שאר הסקרייפרים המתודות האלה זורקות
מהמימוש הבסיסי. השירות מזהה זאת בזמן ריצה בהשוואה ל-`BaseScraper.prototype`, כך שהזרימה תעבוד
מעצמה בכל ספק שהספרייה תוסיף לו תמיכה בעתיד:

* ספק עם תמיכה דו-שלבית → `POST /connect` מפעיל `triggerTwoFactorAuth`, פותח session
  (TTL שלוש דקות, בזיכרון בלבד, מחזיק את הדפדפן פתוח) ומחזיר `requires_otp: true`.
  `POST /otp` ממיר את הקוד לטוקן ארוך-טווח, מאמת אותו בסקרייפינג אמיתי, שומר את החיבור
  ומוחק את הסשן. שלוש טעויות מוחקות את הסשן, וסשן שפג מחזיר `unknown`.
* ספק בלי תמיכה דו-שלבית שדורש OTP → הספרייה מחזירה `TWO_FACTOR_RETRIEVER_MISSING`
  והשירות מחזיר `otp_required`.

## אבטחה ולוגים

* `credentials` נשמרים מוצפנים ב-AES-256-GCM בלבד (`v1:iv:tag:ciphertext`, IV חדש בכל הצפנה,
  קובץ במצב 0600, כתיבה אטומית דרך rename).
* לוגים נכתבים דרך `src/logger.js`, שמסנן הכול פרט לרשימת שדות מותרת:
  `route`, `provider`, `connection_id`, `error_code`, `status`, `duration_ms`, `transactions`,
  `accounts`, `event`. credentials, סיסמאות, קודי OTP ותוכן מפוענח לא מגיעים ללוג בשום מסלול,
  כולל מסלולי שגיאה.
* השוואת ה-API key נעשית ב-`timingSafeEqual` על hash, כך שאורך המפתח לא נחשף.

## מבנה

```
src/config.js    רשימת ספקים, קבועים (110 שניות, TTL 3 דקות, 3 נסיונות OTP, 90 יום)
src/crypto.js    AES-256-GCM
src/store.js     connections.json על ה-Volume, כתיבה אטומית
src/sessions.js  סשני OTP בזיכרון עם TTL
src/locks.js     נעילת סנכרון per connection_id
src/scraper.js   createScraper, תקרת 110 שניות, מיפוי טרנזקציות
src/errors.js    קודי השגיאה והמיפוי מהספרייה
src/app.js       הראוטים והמידלוור
src/server.js    עלייה, בדיקת תצורה, כיבוי מסודר
```
