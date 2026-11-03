import { randomUUID } from 'node:crypto';

export async function receiveMessage(store, config, message, event, client) {
  if (
    message.subtype ||
    message.bot_id ||
    !message.text ||
    !event.event_id ||
    message.user !== config.ownerId ||
    event.team_id !== config.teamId
  )
    return;
  const threadTs = message.thread_ts || message.ts;
  if (message.text.length > 8000) {
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: threadTs,
      text: '요청이 너무 깁니다. 8000자 이내로 작성하세요.',
    });
    return;
  }
  let original = message.thread_ts
    ? store.messageRun(message.channel, message.thread_ts)
    : null;
  if (
    !original &&
    message.channel === store.setting('dmChannel') &&
    !message.thread_ts
  ) {
    const target = store.target(store.setting('dmTarget') || '');
    if (target) original = { jobName: 'DM', target, channel: message.channel };
    else {
      const draftId = `dm:${event.event_id}`;
      if (store.setting(draftId)) return;
      store.setSetting(
        draftId,
        JSON.stringify({
          eventId: event.event_id,
          text: message.text,
          channel: message.channel,
          threadTs,
        }),
      );
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: '이 메시지를 전달할 로컬 세션을 선택하세요.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'plain_text',
              text: '먼저 대화할 로컬 세션을 선택하세요. 선택하면 방금 보낸 요청을 전달합니다.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'choose_dm_session',
                value: draftId,
                text: { type: 'plain_text', text: '세션 선택' },
              },
            ],
          },
        ],
      });
      return;
    }
  }
  if (!original) return;
  if (!store.ownsTarget(original.target.id))
    throw new Error('Session belongs to another profile.');
  const id = store.enqueueReply(
    event.event_id,
    original,
    message.text,
    threadTs,
  );
  if (id)
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: threadTs,
      text: `${original.target.label}에 전달할 요청을 접수했습니다. 세션이 작업 중이면 대기합니다.`,
      mrkdwn: false,
    });
}

export function selectDmTarget(store, targetId, draftId) {
  const target = store.target(targetId);
  if (!target) throw new Error('세션을 다시 선택하세요.');
  store.bindTargets([target]);
  store.setSetting('dmTarget', targetId);
  const draft = draftId && store.setting(draftId);
  if (draft) {
    const pending = JSON.parse(draft);
    store.enqueueReply(
      pending.eventId || randomUUID(),
      { jobName: 'DM', target, channel: pending.channel },
      pending.text,
      pending.threadTs,
    );
    store.db.prepare('DELETE FROM settings WHERE key=?').run(draftId);
  }
  return target;
}
