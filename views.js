const plain = (text) => ({ type: 'plain_text', text });
const option = (target) => ({
  text: plain(target.label.slice(0, 75)),
  value: target.id,
});
const input = (id, label, element, optional = false) => ({
  type: 'input',
  block_id: id,
  label: plain(label),
  element: { action_id: 'value', ...element },
  optional,
});

export function editor(job, targets, channel) {
  const selected = new Set(job?.targets.map((target) => target.id) ?? []);
  const options = targets.slice(0, 100).map(option);
  return {
    type: 'modal',
    callback_id: 'schedule_details',
    private_metadata: job?.id ?? '',
    title: plain(job ? '예약 수정' : '예약 만들기'),
    submit: plain('채널 설정'),
    close: plain('취소'),
    blocks: [
      input('name', '예약 이름', {
        type: 'plain_text_input',
        max_length: 80,
        ...(job && { initial_value: job.name }),
      }),
      input('minutes', '실행 간격 (분)', {
        type: 'number_input',
        is_decimal_allowed: false,
        min_value: '1',
        max_value: '525600',
        initial_value: String(job?.minutes ?? 30),
      }),
      input('targets', '대상 세션 — 여러 개 선택 가능', {
        type: 'multi_static_select',
        options,
        max_selected_items: 90,
        ...(selected.size && {
          initial_options: options.filter((item) => selected.has(item.value)),
        }),
      }),
      input('prompt', '실행할 프롬프트 또는 스킬 호출', {
        type: 'plain_text_input',
        multiline: true,
        max_length: 3000,
        ...(job && { initial_value: job.prompt }),
      }),
      input(
        'channel',
        '예약 기본 채널',
        {
          type: 'conversations_select',
          filter: {
            include: ['public', 'private', 'im'],
            exclude_external_shared_channels: true,
          },
          ...(channel && { initial_conversation: channel }),
        },
        true,
      ),
      {
        type: 'context',
        elements: [
          plain(
            '본인의 Mac에서 실행 중인 세션만 선택합니다. 에이전트가 작업 중이면 입력을 기다립니다. 봇을 결과 채널에 추가하세요.',
          ),
        ],
      },
    ],
  };
}

export function routing(draftId, job) {
  return {
    type: 'modal',
    callback_id: 'schedule_routes',
    private_metadata: draftId,
    title: plain('세션별 결과 채널'),
    submit: plain('예약 저장'),
    close: plain('취소'),
    blocks: [
      {
        type: 'section',
        text: plain(
          '각 세션의 결과 채널을 지정할 수 있습니다. 비워 두면 예약의 기본 채널을 사용합니다.',
        ),
      },
      ...job.targets.map((target, index) =>
        input(
          `target_${index}`,
          target.label.slice(0, 200),
          {
            type: 'conversations_select',
            filter: {
              include: ['public', 'private', 'im'],
              exclude_external_shared_channels: true,
            },
            ...(target.channel && { initial_conversation: target.channel }),
          },
          true,
        ),
      ),
    ],
  };
}

export const value = (view, id) => view.state.values[id]?.value;

export function sessionPicker(targets, draftId = '') {
  return {
    type: 'modal',
    callback_id: 'dm_target',
    private_metadata: draftId,
    title: plain('DM 대화 세션'),
    close: plain('닫기'),
    ...(targets.length && { submit: plain('연결') }),
    blocks: targets.length
      ? [
          input('target', '대화할 세션', {
            type: 'static_select',
            options: targets.slice(0, 100).map(option),
          }),
        ]
      : [
          {
            type: 'section',
            text: plain(
              '연결할 세션이 없습니다. 이 Mac에서 Codex 또는 Claude Code를 실행하세요. 다른 프로필에 연결된 세션은 표시하지 않습니다.',
            ),
          },
        ],
  };
}

export function help() {
  return [
    '*예약 관리*',
    '`/semi target` — DM으로 대화할 세션 선택·변경',
    '`/semi name 원하는이름` — 봇 이름 변경',
    '`/semi new` — 예약 생성: 여러 세션·실행 간격·프롬프트·채널',
    '`/semi list` — 예약 목록',
    '`/semi edit 예약ID` — 대상·내용·주기·채널 수정',
    '`/semi pause 예약ID` / `resume 예약ID` — 중지·재개',
    '`/semi delete 예약ID` — 예약 삭제 (이미 전달된 작업은 취소되지 않음)',
    '`/semi status 예약ID` — 세션별 실행 상태',
    '`/semi resolve 실행ID` — 전달 여부를 확인한 뒤 대기 해제',
    '`/semi default-channel` — 현재 채널을 봇 기본 채널로 설정',
  ].join('\n');
}
