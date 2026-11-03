/**
 * Posture Lab レポート受信用 Google Apps Script（メール送信＋Googleカレンダー登録）
 * 1. https://script.google.com で新規プロジェクトを作成し、このファイルの内容を貼り付ける
 * 2. 下の SECRET を任意の文字列に変更（アプリの「GAS 共有シークレット」と同じ値にする）
 * 3. デプロイ →「新しいデプロイ」→ 種類「ウェブアプリ」
 *    実行ユーザー：自分　／　アクセスできるユーザー：全員
 * 4. 発行された .../exec のURLをアプリの「Google Apps Script ウェブアプリURL」に貼り付ける
 * 初回デプロイ時に Gmail・カレンダーへのアクセス許可を求められるので承認する。
 */
const SECRET = 'change-me';
const CALENDAR_ID = 'primary'; // 専用カレンダーに入れる場合はそのカレンダーIDに変更

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) return out({ ok: false, error: 'bad secret' });
    const to = body.to || Session.getEffectiveUser().getEmail();

    if (body.subject) {
      MailApp.sendEmail({ to: to, subject: body.subject, body: body.text || '', htmlBody: body.html || undefined, name: 'Posture Lab' });
    }
    if (body.calendar) {
      const cal = CALENDAR_ID === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CALENDAR_ID);
      const ev = cal.createEvent(body.calendar.title, new Date(body.calendar.start), new Date(body.calendar.end), { description: body.calendar.description || '' });
      ev.setColor(CalendarApp.EventColor.PALE_GREEN);
      ev.removeAllReminders();
    }
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() { return out({ ok: true, service: 'posture-lab-report' }); }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// エディタから実行して動作確認する用
function testSend() {
  doPost({ postData: { contents: JSON.stringify({ secret: SECRET, subject: '【Posture Lab】テスト', text: 'テスト送信です', calendar: { title: 'Posture Lab テスト', start: Date.now(), end: Date.now() + 15 * 60000, description: 'テスト' } }) } });
}
