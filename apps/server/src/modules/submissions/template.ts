import {
  REQUIRED_TEMPLATE_FIELDS,
  type ParseStatus,
  type SubmissionFields,
  type TemplateField,
} from '@workbench/contracts';

/**
 * 投稿模板：
 * 投稿｜想做啥：___｜给谁用：___｜解决啥问题：___｜希望它能干啥：___｜最希望先做哪3件事：___
 * ｜想要几个页面、分别放啥：___｜做到啥样算完成：___｜喜欢啥风格（选填）：___
 *
 * 标签先归一化（去空白与标点、括注、“三”→“3”）再查表。解析只是整理的起点，
 * 结果可由人工修改；原文始终原样保存。
 */
const FIELD_BY_LABEL: Record<string, TemplateField> = {
  想做啥: 'title',
  想做什么: 'title',
  给谁用: 'targetUsers',
  解决啥问题: 'problem',
  解决什么问题: 'problem',
  希望它能干啥: 'desiredFeatures',
  希望它能干什么: 'desiredFeatures',
  最希望先做哪3件事: 'viewerPriorities',
  想要几个页面分别放啥: 'pageScope',
  想要几个页面分别放什么: 'pageScope',
  做到啥样算完成: 'completionCriteria',
  做到什么样算完成: 'completionCriteria',
  喜欢啥风格: 'style',
  喜欢什么风格: 'style',
};

const LIST_FIELDS: Record<string, true> = { desiredFeatures: true, viewerPriorities: true };

export interface ParsedSubmission {
  fields: SubmissionFields;
  parseStatus: ParseStatus;
}

export function emptyFields(): SubmissionFields {
  return {
    title: null,
    targetUsers: null,
    problem: null,
    desiredFeatures: [],
    viewerPriorities: [],
    pageScope: null,
    completionCriteria: null,
    style: null,
  };
}

/** 拆分功能列表：顿号、分号、逗号、换行及“1.”“2、”“③”之类的编号。 */
export function splitFeatureList(value: string): string[] {
  return value
    .split(/[、；;，,\n]|(?:^|\s)(?:\d{1,2}|[①-⑳])[.、．)）:：]?\s*(?=\S)/u)
    .map((s) => s.replace(/^\s*(?:\d{1,2}[.、．)）]|[①-⑳])\s*/u, '').trim())
    .filter((s) => s.length > 0 && !/^_+$/.test(s));
}

export function parseSubmissionText(rawText: string): ParsedSubmission {
  const fields = emptyFields();
  let recognized = 0;

  for (const segment of rawText.split(/[｜|]/)) {
    const sep = segment.search(/[：:]/);
    if (sep < 0) continue;
    const label = segment
      .slice(0, sep)
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s、，,。.]/g, '')
      .replace(/三/g, '3');
    const field = FIELD_BY_LABEL[label];
    if (!field) continue;
    const value = segment.slice(sep + 1).trim();
    if (value.length === 0 || /^_+$/.test(value)) continue;

    if (LIST_FIELDS[field]) {
      const items = splitFeatureList(value);
      if (items.length === 0) continue;
      (fields[field as 'desiredFeatures' | 'viewerPriorities'] as string[]).push(...items);
    } else {
      fields[field as Exclude<TemplateField, 'desiredFeatures' | 'viewerPriorities'>] = value;
    }
    recognized++;
  }

  const missing = missingFields(fields);
  const parseStatus: ParseStatus =
    recognized === 0 ? 'unparsed' : missing.length === 0 ? 'complete' : 'partial';
  return { fields, parseStatus };
}

export function missingFields(fields: SubmissionFields): TemplateField[] {
  return REQUIRED_TEMPLATE_FIELDS.filter((f) => {
    const v = fields[f];
    return Array.isArray(v) ? v.length === 0 : v === null;
  });
}
