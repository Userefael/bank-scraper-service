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
| `SCRAPE_TIMEOUT_MS` | לא | תקרת הסקרייפינג ב-`/sync`. ברירת מחדל 110000. |
| `CONNECT_TIMEOUT_MS` | לא | תקרת הסקרייפינג ב-`/connect` וב-`/otp`. ברירת מחדל 90000. |
| `LOGIN_WAIT_MS` | לא | כמה זמן ממתינים לתוצאת התחברות או לדף הקוד. ברירת מחדל 45000. |
| `INTERACTIVE_OTP_PROVIDERS` | לא | רשימת ספקים שההתחברות אליהם מנוהלת על ידי השירות עצמו, מופרדת בפסיקים. ריק כברירת מחדל, כלומר כולם עוברים דרך הסקרייפר של הספרייה. הערך הנתמך היחיד הוא `hapoalim`. |
| `FAST_ANSWER_MS` | לא | כמה זמן `/connect` ממתין להתחברות מנוהלת לפני שהוא מחזיר `session_id` וממשיך ברקע. ברירת מחדל 45000. |
| `DEBUG_LOGIN_PAGE` | לא | אינו נדרש עוד; מבנה הדף נרשם ללוג תמיד כשההתחברות נוחתת במקום לא מזוהה. |

**התקרות האלה צריכות להיות נמוכות מה-timeout של ה-gateway שמול השירות.** אם ה-proxy חותך
ב-60 שניות והתקרה כאן היא 90, הלקוח מקבל 504 עם HTML במקום `{ ok:false, error_code:"timeout" }`,
ואין לו שום דרך להבדיל בין השניים. במקרה כזה כדאי להגדיר `CONNECT_TIMEOUT_MS` לערך כמו 50000.

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

POST /debug/login ← { provider, credentials }        → { ok: true, status, outcome, page }
```

`/debug/login` מריץ התחברות אמיתית ומדווח על הדף שאליו היא הגיעה, בלי לשמור חיבור ובלי
להחזיר ערכים מהדף — רק כתובת, כותרת, ושמות ותוויות של שדות וכפתורים. הוא נועד לריצה מכוונת
אחת כשהתחברות נכשלת בפרודקשן ואין גישה נוחה ללוגים. **הוא מנסה להתחבר לבנק בפועל**, ובנקים
נועלים חשבון שמפציצים אותו בניסיונות, אז לא להריץ אותו בלולאה.

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

## כמה זמן כל ראוט לוקח

`/connect` ו-`/otp` מריצים סקרייפינג עם חלון של יום אחד אחורה, כי כל מה שהם צריכים להוכיח
הוא שההתחברות עובדת; הטרנזקציות שהם מקבלים נזרקות. `/sync` הוא זה שמביא נתונים, והוא משתמש
ב-`since` שקיבל או ב-90 יום אחורה כברירת מחדל. המשמעות היא ש-`/connect` אורך בערך כמו
התחברות לבנק, ולא כמו התחברות ועוד שליפה של רבעון.

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

בספרייה עצמה, בגרסה 6.12.1, רק סקרייפר אחד מממש בפועל
`triggerTwoFactorAuth` / `getLongTermTwoFactorToken`, והוא `oneZero`; בכל השאר המתודות האלה
זורקות מהמימוש הבסיסי, וגם `otpCodeRetriever` קיים רק ב-`loginFields` של `oneZero`. לכן
לספקים האחרים אין בספרייה שום נקודת הזרקה לקוד: כשהבנק מציג דף קוד, הסקרייפר של הספרייה
ממתין לרידיירקט שלא מגיע עד שהוא נחתך.

השירות יודע לפתור את זה לפועלים בכך שהוא מנהל את ההתחברות בעצמו,
ב-`src/scrapers/hapoalim-otp.js`, **אבל הזרימה הזו כבויה כברירת מחדל**. כדי להדליק אותה
מגדירים `INTERACTIVE_OTP_PROVIDERS=hapoalim`. בלי זה הפועלים עובר דרך הסקרייפר של הספרייה,
שאין לו דרך למסור קוד, ולכן התחברות שדורשת קוד תיכשל שם.
הוא יורש את הסקרייפר של הספרייה, ממלא את שדות ההתחברות ולוחץ כמוהו, ואז מחכה לאחד משניים:
כתובת מוכרת של הצלחה או כישלון, או הופעת שדה קוד בדף. אם הופיע שדה קוד, הדפדפן נשאר פתוח
בסשן ו-`/connect` מחזיר `requires_otp` עם `session_id` תוך שניות. `/otp` מקליד את הקוד
באותו דף, ממשיך לדף הבית, ומשם שליפת הנתונים היא של הספרייה כרגיל. הרשימה נמצאת ב-
`INTERACTIVE_OTP_PROVIDERS` ב-`src/config.js`, וספק נוסף יצטרך מימוש משלו.

הדיאלוג של הפועלים נפתח מעל דף ההתחברות ואינו משנה את הכתובת, ולכן אי אפשר לזהות אותו לפי
URL. הזיהוי מבני: הבנק מפצל את הקוד לחמש תיבות של תו אחד, אז תיבות `maxlength="1"` גלויות הן
החתימה שמחפשים, ובמקביל נבדק אם טקסט הדף מכיל ניסוח כמו "קוד האימות" או "כניסה חדשה ממחשב".
גם שדה בודד ששמו נראה כמו קוד מזוהה. הסריקה עוברת על כל הפריימים, והאלמנטים שנמצאו מסומנים
ב-`data-scraper-otp-field` כדי לפנות אליהם בלי לנחש סלקטור. הקוד מוקלד תו-תו לתיבות, והכפתור
נמצא לפי הטקסט שלו ("המשך", "אישור", "שלח") ולא לפי מחלקה. הלוגיקה שבוחרת את השדות היא
פונקציה טהורה, `chooseOtpFields`, ויש לה בדיקות.

כשההתחברות נוחתת בדף שאינו מזוהה, השירות רושם שורת `login_page_unrecognised` עם הכתובת,
הכותרת, ושמות, סוגים ותוויות של השדות והכפתורים בכל פריים. בלי ערכים ובלי טקסט הדף עצמו,
רק האם הטקסט נראה כמו אתגר קוד.

### פרופיל דפדפן לכל חיבור

כל חיבור מקבל תיקיית פרופיל של Chromium תחת `/data/profiles/<connection_id>`, והשירות פותח
את הדפדפן בעצמו ומעביר אותו לספרייה. המשמעות היא שהעוגיות של הבנק נשמרות בין סנכרונים, ולכן
בנק שדורש קוד רק ממכשיר לא מוכר אמור לדרוש אותו פעם אחת ולא בכל סנכרון. `/disconnect` מוחק
את הפרופיל יחד עם החיבור, וכך גם חיבור שנכשל. השירות מזהה זאת בזמן ריצה בהשוואה ל-`BaseScraper.prototype`, כך שהזרימה תעבוד
מעצמה בכל ספק שהספרייה תוסיף לו תמיכה בעתיד:

`/connect` של ספק מנוהל לא ממתין לסיום ההתחברות. הוא מחכה עד `FAST_ANSWER_MS`, ואם עד אז
לא הוכרעה התוצאה הוא פותח סשן ומחזיר `requires_otp` עם `session_id`, בעוד ההתחברות ממשיכה
ברקע באותו דפדפן. ההמתנה הזו צריכה להיות ארוכה מהתחברות רגילה, אחרת כל התחברות איטית
נראית כאילו הבנק ביקש קוד; הלוג `login_settled` מראה במה נגמרה התחברות שנמסרה לרקע.
סשן חי רק בזיכרון התהליך, ולכן איתחול של השירות מוחק אותו; `/otp` על סשן שאינו קיים מחזיר
`timeout`, כלומר הקוד כבר לא תקף ויש להתחבר מחדש, ולא `unknown` שנקרא כאילו הקוד שגוי. הסיבה פשוטה: התחברות לבנק אורכת יותר ממה ש-gateway טיפוסי מוכן להמתין,
ותשובה שמגיעה אחרי שהוא ויתר היא תשובה שאיש לא מקבל. `/otp` ממתין להתחברות שברקע לפני
שהוא מקליד את הקוד, וכך אין זה משנה אם המשתמש הקליד מהר או לאט. אם בינתיים ההתחברות
הצליחה בלי קוד, כי הבנק זיהה את המכשיר, הקוד פשוט לא בשימוש והחיבור נשמר.

התחברות מנוהלת גם לא מבצעת שליפת נתונים: היא רק מוכיחה שהפרטים עובדים, ו-`/sync` הוא
שמביא נתונים. זה מה שמאפשר ל-`/otp` לענות בזמן שהקוד עדיין תקף.

* ספק עם תמיכה דו-שלבית → `POST /connect` מפעיל `triggerTwoFactorAuth`, פותח session
  (TTL שלוש דקות, בזיכרון בלבד, מחזיק את הדפדפן פתוח) ומחזיר `requires_otp: true`.
  `POST /otp` ממיר את הקוד לטוקן ארוך-טווח, מאמת אותו בסקרייפינג אמיתי, שומר את החיבור
  ומוחק את הסשן. שלוש טעויות מוחקות את הסשן, וסשן שפג מחזיר `unknown`.
* ספק שאינו ברשימה ואין לו תמיכה דו-שלבית בספרייה → במקרה הטוב הספרייה מחזירה
  `TWO_FACTOR_RETRIEVER_MISSING` והשירות מחזיר `otp_required`; במקרה הפחות טוב ההתחברות
  נתקעת בדף הקוד עד לתקרת הזמן והשירות מחזיר `timeout`. ספק כזה דורש מימוש ייעודי כמו זה
  של הפועלים.

## אבטחה ולוגים

* `credentials` נשמרים מוצפנים ב-AES-256-GCM בלבד (`v1:iv:tag:ciphertext`, IV חדש בכל הצפנה,
  קובץ במצב 0600, כתיבה אטומית דרך rename).
* לוגים נכתבים דרך `src/logger.js`, שמסנן הכול פרט לרשימת שדות מותרת:
  `route`, `provider`, `connection_id`, `error_code`, `status`, `duration_ms`, `transactions`,
  `accounts`, `event`, `reason`. credentials, סיסמאות, קודי OTP ותוכן מפוענח לא מגיעים ללוג
  בשום מסלול, כולל מסלולי שגיאה. `reason` נושא הודעת שגיאה של הספרייה או של פאפטיר, שמכילה
  כתובות וקודי סטטוס אך לא ערכים, וכל רצף של ארבע ספרות ומעלה מוחלף ב-`***` ליתר ביטחון.
* השוואת ה-API key נעשית ב-`timingSafeEqual` על hash, כך שאורך המפתח לא נחשף.

## מבנה

```
src/config.js    רשימת ספקים, קבועים (110 שניות, TTL 3 דקות, 3 נסיונות OTP, 90 יום)
src/crypto.js    AES-256-GCM
src/store.js     connections.json על ה-Volume, כתיבה אטומית
src/sessions.js  סשני OTP בזיכרון עם TTL
src/locks.js     נעילת סנכרון per connection_id
src/scraper.js   createScraper, תקרות זמן, מיפוי טרנזקציות
src/login.js     שלוש דרכי ההתחברות: ניהול עצמי, דו-שלבי של הספרייה, וסקרייפ רגיל
src/browser.js   הרמת Chromium עם פרופיל קבוע לכל חיבור
src/scrapers/hapoalim-otp.js  התחברות לפועלים שעוצרת בדף הקוד
src/errors.js    קודי השגיאה והמיפוי מהספרייה
src/app.js       הראוטים והמידלוור
src/server.js    עלייה, בדיקת תצורה, כיבוי מסודר
```
