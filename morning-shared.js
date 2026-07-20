(function () {
  const STORAGE_KEY = 'morningConversationRecords.v1';
  const STUDENT_COUNT = 24;
  let recordsSyncStatus = {
    ok: false,
    source: 'local',
    message: ''
  };
  const studentPasscodes = {
    '1': '218',
    '2': '347',
    '3': '506',
    '4': '694',
    '5': '835',
    '6': '129',
    '7': '472',
    '8': '760',
    '9': '913',
    '10': '284',
    '11': '631',
    '12': '058',
    '13': '397',
    '14': '845',
    '15': '120',
    '16': '568',
    '17': '709',
    '18': '236',
    '19': '984',
    '20': '451',
    '21': '672',
    '22': '805',
    '23': '319',
    '24': '746'
  };

  const questions = [
    {
      key: 'sleep',
      label: '수면상태',
      prompt: '좋은 아침. 어젯밤 잠은 어땠어?',
      emptyPrompt: '잘 기억나지 않으면 괜찮아. 잘 잤어, 조금 피곤해, 잘 모르겠어처럼 말해도 돼.'
    },
    {
      key: 'breakfast',
      label: '아침밥 유무',
      prompt: '아침은 먹고 왔어? 조금만 먹었어도 괜찮아.',
      emptyPrompt: '아침을 못 먹었어도 괜찮아. 먹었어, 안 먹었어, 조금 먹었어처럼 말해줘.'
    },
    {
      key: 'special',
      label: '특이사항',
      prompt: '오늘 선생님이 알아두면 좋을 일이 있을까?',
      emptyPrompt: '생각나는 일이 없으면 없었어라고 말해도 괜찮아.'
    },
    {
      key: 'mood',
      label: '아침기분',
      prompt: '지금 마음은 어때? 네 말로 편하게 들려줘.',
      emptyPrompt: '딱 맞는 말이 안 떠오르면 좋아, 보통이야, 피곤해처럼 짧게 말해도 좋아.'
    },
    {
      key: 'conflict',
      label: '친구와의 갈등상황',
      prompt: '친구 일로 마음에 남은 게 있어?',
      emptyPrompt: '친구와 특별한 일이 없었다면 없었다고 말해도 괜찮아.'
    }
  ];

  const labels = Object.fromEntries(questions.map(question => [question.key, question.label]));

  function nowIso() {
    return new Date().toISOString();
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('ko-KR', { hour12: false });
  }

  function localDateKey(value = nowIso()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getRecordDateKey(record) {
    if (!record) return '';
    return record.recordDate || localDateKey(record.startedAt || record.updatedAt || record.completedAt);
  }

  function getRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.warn(error);
      return {};
    }
  }

  function getStudentPasscode(studentNo) {
    return studentPasscodes[String(Number(studentNo))] || '';
  }

  function verifyStudentPasscode(studentNo, passcode) {
    const normalizedNo = String(Number(studentNo));
    const normalizedPasscode = String(passcode || '').trim();
    return Boolean(studentPasscodes[normalizedNo]) && studentPasscodes[normalizedNo] === normalizedPasscode;
  }

  function saveRecords(records) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  function getTodayRecords(records = getRecords()) {
    const todayKey = localDateKey();
    return Object.fromEntries(
      Object.entries(records || {}).filter(([, record]) => getRecordDateKey(record) === todayKey)
    );
  }

  function pruneLocalRecordsForToday() {
    saveRecords(getTodayRecords());
  }

  function getRecordsSyncStatus() {
    return { ...recordsSyncStatus };
  }

  function getApiBaseCandidates() {
    if (window.MORNING_API_BASE) return [String(window.MORNING_API_BASE).replace(/\/$/, '')];
    if (window.location.protocol === 'file:') return ['http://localhost:3000', 'http://127.0.0.1:3000'];
    return [''];
  }

  async function fetchMorningApi(path, options = {}) {
    let lastError = null;
    const candidates = getApiBaseCandidates();
    for (const base of candidates) {
      try {
        return await fetch(`${base}${path}`, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('morning-api-unavailable');
  }

  function normalizeStudentNo(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > STUDENT_COUNT) return '';
    return String(number);
  }

  async function loadRecordsFromServer() {
    if (!window.fetch) return null;
    try {
      const response = await fetchMorningApi('/api/morning-records', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const records = data?.records && typeof data.records === 'object' && !Array.isArray(data.records)
        ? data.records
        : {};
      saveRecords(records);
      recordsSyncStatus = { ok: true, source: 'server', message: '' };
      return records;
    } catch (error) {
      console.warn('아침대화 서버 기록을 불러오지 못했습니다.', error);
      recordsSyncStatus = { ok: false, source: 'local', message: error?.message || 'server-unavailable' };
      return null;
    }
  }

  async function getStudentRecordFromServer(studentNo) {
    const records = await loadRecordsFromServer();
    if (!records) return null;
    return records[String(studentNo)] || null;
  }

  async function getAllStudentRowsAsync() {
    const records = await loadRecordsFromServer();
    return buildStudentRows(records || getTodayRecords());
  }

  async function getStudentRecordHistoryFromServer(studentNo) {
    if (!window.fetch) return [];
    const key = normalizeStudentNo(studentNo);
    if (!key) return [];

    try {
      const response = await fetchMorningApi(`/api/morning-records/${encodeURIComponent(key)}/history`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return Array.isArray(data?.records) ? data.records : [];
    } catch (error) {
      console.warn('학생 날짜별 아침대화 기록을 불러오지 못했습니다.', error);
      return [];
    }
  }

  async function getMorningRecordsByDateFromServer(dateKey = '') {
    if (!window.fetch) return { date: '', dates: [], records: {}, updatedAt: '' };
    const query = dateKey ? `?date=${encodeURIComponent(dateKey)}` : '';

    try {
      const response = await fetchMorningApi(`/api/morning-records/by-date${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return {
        date: typeof data?.date === 'string' ? data.date : '',
        dates: Array.isArray(data?.dates) ? data.dates : [],
        records: data?.records && typeof data.records === 'object' && !Array.isArray(data.records)
          ? data.records
          : {},
        updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : ''
      };
    } catch (error) {
      console.warn('날짜별 아침대화 기록을 불러오지 못했습니다.', error);
      return { date: '', dates: [], records: {}, updatedAt: '' };
    }
  }

  async function saveStudentRecordToServer(record) {
    if (!window.fetch || !record) return;
    try {
      const response = await fetchMorningApi('/api/morning-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record })
      });
      if (response.status === 409) {
        await loadRecordsFromServer();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn('아침대화 기록을 서버에 저장하지 못했습니다.', error);
    }
  }

  async function deleteStudentRecordFromServer(studentNo, dateKey) {
    if (!window.fetch) return { ok: false, reason: 'server-unavailable' };
    const key = normalizeStudentNo(studentNo);
    if (!key) return { ok: false, reason: 'not-found' };
    const query = dateKey ? `?date=${encodeURIComponent(dateKey)}` : '';

    try {
      const response = await fetchMorningApi(`/api/morning-records/${encodeURIComponent(key)}${query}`, {
        method: 'DELETE'
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        deleteStudentRecord(key, dateKey);
        await loadRecordsFromServer();
        return data;
      }
      return {
        ok: false,
        reason: data.reason || 'server-error',
        recordDate: data.recordDate || ''
      };
    } catch (error) {
      console.warn('아침대화 서버 기록을 삭제하지 못했습니다.', error);
      return { ok: false, reason: 'server-error' };
    }
  }

  function createRecord(studentNo) {
    return {
      studentNo: String(studentNo),
      recordDate: localDateKey(),
      answers: {},
      transcript: [],
      startedAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: ''
    };
  }

  function getStudentRecord(studentNo) {
    const records = getRecords();
    return records[String(studentNo)] || null;
  }

  function saveStudentRecord(record) {
    const records = getRecords();
    const normalized = {
      ...record,
      studentNo: String(record.studentNo),
      updatedAt: nowIso()
    };
    records[normalized.studentNo] = normalized;
    saveRecords(records);
    saveStudentRecordToServer(normalized);
    return normalized;
  }

  function deleteStudentRecord(studentNo, dateKey) {
    const records = getRecords();
    const key = String(Number(studentNo));
    const record = records[key];

    if (!record) {
      return { ok: false, reason: 'not-found' };
    }

    const recordDate = getRecordDateKey(record);
    if (dateKey && recordDate !== dateKey) {
      return { ok: false, reason: 'date-mismatch', recordDate };
    }

    delete records[key];
    saveRecords(records);
    return { ok: true, recordDate };
  }


  function isNoneText(text) {
    const value = String(text || '').replace(/\s+/g, '');
    return /(없어|없었|없음|없어요|아니야|아니요|괜찮아|괜찮아요|특별한일없|별일없|모르겠)/.test(value);
  }

  function summarizeAnswer(key, text) {
    const value = String(text || '').trim();
    const compact = value.replace(/\s+/g, '');
    if (!value) return '미응답';

    if (key === 'sleep') {
      if (/(못잤|잠이안|부족|피곤|졸려|늦게|자주깼|설쳤|별로)/.test(compact)) return `수면 부족/피곤: ${value}`;
      if (/(잘잤|푹잤|충분|좋았|괜찮)/.test(compact)) return `양호: ${value}`;
      return `확인 필요: ${value}`;
    }

    if (key === 'breakfast') {
      if (/(안먹|못먹|굶|아니|없)/.test(compact)) return `먹지 않음: ${value}`;
      if (/(조금|반만|대충|우유|과자만)/.test(compact)) return `조금 먹음: ${value}`;
      if (/(먹었|먹고|밥|빵|시리얼|과일|우유|김밥|죽)/.test(compact)) return `먹음: ${value}`;
      return `확인 필요: ${value}`;
    }

    if (key === 'special') {
      if (isNoneText(value)) return '없음';
      return `있음: ${value}`;
    }

    if (key === 'mood') {
      if (/(좋|기뻐|행복|신나|재밌|설레)/.test(compact)) return `밝음: ${value}`;
      if (/(피곤|졸려|힘들|무기력|지침)/.test(compact)) return `피곤함: ${value}`;
      if (/(속상|슬퍼|우울|눈물|서운)/.test(compact)) return `속상함: ${value}`;
      if (/(화나|짜증|답답|억울|불공평)/.test(compact)) return `답답함/화남: ${value}`;
      if (/(걱정|불안|무서|긴장|떨려)/.test(compact)) return `걱정/불안: ${value}`;
      if (/(보통|괜찮|그냥|모르겠)/.test(compact)) return `보통: ${value}`;
      return `기타: ${value}`;
    }

    if (key === 'conflict') {
      if (isNoneText(value)) return '없음';
      return `있음: ${value}`;
    }

    return value;
  }

  function answerStatus(key, summary) {
    const text = String(summary || '');
    if (!summary || summary === '미응답') return 'missing';
    if (key === 'sleep' && /부족|피곤|확인 필요/.test(text)) return 'watch';
    if (key === 'breakfast' && /먹지 않음|확인 필요/.test(text)) return 'watch';
    if (key === 'special' && /^있음/.test(text)) return 'watch';
    if (key === 'mood' && /피곤|속상|답답|화남|걱정|불안|기타/.test(text)) return 'watch';
    if (key === 'conflict' && /^있음/.test(text)) return 'watch';
    return 'ok';
  }

  function getAnswer(record, key) {
    return record?.answers?.[key] || { raw: '', summary: '미응답', answeredAt: '' };
  }

  function isComplete(record) {
    return questions.every(question => Boolean(record?.answers?.[question.key]?.raw));
  }

  function needsAttention(record) {
    return questions.some(question => answerStatus(question.key, getAnswer(record, question.key).summary) === 'watch');
  }

  function buildStudentSummary(record) {
    if (!record) return '기록 없음';
    const parts = questions.map(question => {
      const answer = getAnswer(record, question.key);
      return `${question.label}: ${answer.summary || '미응답'}`;
    });
    const expression = record.expression
      ? `카메라 표정 신호: ${record.expression.label}(${record.expression.confidence}%)`
      : '카메라 표정 신호: 없음';
    const expressionHistoryCount = Array.isArray(record.expressionHistory) ? record.expressionHistory.length : 0;
    return `${record.studentNo}번 - ${parts.join(' / ')} / ${expression} / 표정 변화 기록 ${expressionHistoryCount}개`;
  }

  function buildStudentRows(records) {
    return Array.from({ length: STUDENT_COUNT }, (_, index) => {
      const studentNo = String(index + 1);
      const record = records[studentNo] || null;
      return {
        studentNo,
        record,
        complete: isComplete(record),
        attention: needsAttention(record)
      };
    });
  }

  function getAllStudentRows() {
    return buildStudentRows(getRecords());
  }

  function buildOverallReport() {
    const rows = getAllStudentRows();
    const completed = rows.filter(row => row.complete);
    const attention = rows.filter(row => row.record && row.attention);
    const noBreakfast = rows.filter(row => /먹지 않음/.test(getAnswer(row.record, 'breakfast').summary));
    const tired = rows.filter(row => /부족|피곤/.test(getAnswer(row.record, 'sleep').summary));
    const conflicts = rows.filter(row => /^있음/.test(getAnswer(row.record, 'conflict').summary));

    const lines = [
      '아침대화 관리자 요약 리포트',
      `생성 시각: ${formatDate(nowIso())}`,
      '',
      '[전체 현황]',
      `- 완료 학생: ${completed.length}/${STUDENT_COUNT}명`,
      `- 확인이 필요한 학생: ${attention.length}명`,
      `- 아침밥을 먹지 않은 학생: ${noBreakfast.length}명`,
      `- 수면 부족/피곤 학생: ${tired.length}명`,
      `- 친구 갈등이 있는 학생: ${conflicts.length}명`,
      '',
      '[확인 필요 학생]',
      ...(attention.length
        ? attention.map(row => `- ${buildStudentSummary(row.record)}`)
        : ['- 없음']),
      '',
      '[학생 비밀번호]',
      ...rows.map(row => `- ${row.studentNo}번: ${getStudentPasscode(row.studentNo)}`),
      '',
      '[학생별 요약]',
      ...rows.map(row => row.record ? `- ${buildStudentSummary(row.record)}` : `- ${row.studentNo}번 - 미작성`),
      '',
      '[표정 변화 기록]',
      ...rows.flatMap(row => {
        if (!row.record) return [`- ${row.studentNo}번 - 기록 없음`];
        const history = Array.isArray(row.record.expressionHistory) ? row.record.expressionHistory : [];
        if (!history.length) return [`- ${row.studentNo}번 - 표정 변화 기록 없음`];
        return [
          `- ${row.studentNo}번`,
          ...history.map(item => `  ${formatDate(item.updatedAt)}: ${item.label}(${item.confidence}%)`)
        ];
      }),
      '',
      '[대화 전문]',
      ...rows.flatMap(row => {
        if (!row.record?.transcript?.length) return [`- ${row.studentNo}번 - 기록 없음`];
        return [
          `- ${row.studentNo}번`,
          ...row.record.transcript.map(item => {
            const speaker = item.role === 'student' ? '학생' : '콩이';
            const label = labels[item.key] || '대화';
            return `  ${formatDate(item.time)} / ${speaker} / ${label}: ${item.text}`;
          })
        ];
      })
    ];

    return lines.join('\n');
  }

  function csvEscape(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function buildCsv() {
    const headers = ['번호', '비밀번호', '완료여부', '수면상태', '아침밥 유무', '특이사항', '아침기분', '카메라 표정 신호', '표정 변화 기록', '친구와의 갈등상황', '마지막 저장'];
    const rows = getAllStudentRows().map(row => {
      const record = row.record;
      return [
        row.studentNo,
        getStudentPasscode(row.studentNo),
        row.complete ? '완료' : '미완료',
        getAnswer(record, 'sleep').summary,
        getAnswer(record, 'breakfast').summary,
        getAnswer(record, 'special').summary,
        getAnswer(record, 'mood').summary,
        record?.expression ? `${record.expression.label}(${record.expression.confidence}%)` : '없음',
        Array.isArray(record?.expressionHistory)
          ? record.expressionHistory.map(item => `${formatDate(item.updatedAt)} ${item.label}(${item.confidence}%)`).join(' / ')
          : '없음',
        getAnswer(record, 'conflict').summary,
        formatDate(record?.updatedAt)
      ];
    });
    return [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
  }

  function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  window.MorningApp = {
    STORAGE_KEY,
    STUDENT_COUNT,
    studentPasscodes,
    questions,
    labels,
    nowIso,
    formatDate,
    localDateKey,
    getRecordDateKey,
    getRecords,
    saveRecords,
    getTodayRecords,
    pruneLocalRecordsForToday,
    getRecordsSyncStatus,
    loadRecordsFromServer,
    getStudentRecordFromServer,
    getStudentRecordHistoryFromServer,
    getMorningRecordsByDateFromServer,
    getStudentPasscode,
    verifyStudentPasscode,
    createRecord,
    deleteStudentRecord,
    deleteStudentRecordFromServer,
    getStudentRecord,
    saveStudentRecord,
    saveStudentRecordToServer,
    summarizeAnswer,
    answerStatus,
    getAnswer,
    isComplete,
    needsAttention,
    buildStudentSummary,
    getAllStudentRows,
    getAllStudentRowsAsync,
    buildOverallReport,
    buildCsv,
    downloadText
  };
}());
