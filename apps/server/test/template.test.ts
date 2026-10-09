import { describe, expect, it } from 'vitest';
import { missingFields, parseSubmissionText, splitFeatureList } from '../src/modules/submissions/template.ts';
import { TEMPLATE_SAMPLE } from './helpers.ts';

describe('投稿模板解析', () => {
  it('完整模板解析出全部字段，期望功能全部保留，观众优先项单独记录', () => {
    const { fields, parseStatus } = parseSubmissionText(TEMPLATE_SAMPLE);
    expect(parseStatus).toBe('complete');
    expect(fields).toEqual({
      title: '自习室座位预约',
      targetUsers: '大学生',
      problem: '图书馆占座难',
      desiredFeatures: ['查看空位', '预约座位', '签到', '排行榜', '暗黑模式'],
      viewerPriorities: ['查看空位', '预约座位', '签到'],
      pageScope: '首页看空位，预约页，个人页',
      completionCriteria: '能演示预约到签到全流程',
      style: '清新',
    });
  });

  it('未填写的占位符与缺失字段计入 missingFields，选填风格不算缺失', () => {
    const { fields, parseStatus } = parseSubmissionText('投稿｜想做啥：记账本｜给谁用：___｜喜欢啥风格（选填）：___');
    expect(parseStatus).toBe('partial');
    expect(fields.title).toBe('记账本');
    expect(fields.targetUsers).toBeNull();
    expect(missingFields(fields)).toEqual([
      'targetUsers',
      'problem',
      'desiredFeatures',
      'viewerPriorities',
      'pageScope',
      'completionCriteria',
    ]);
  });

  it('自由文本不套模板时标记 unparsed，不猜测字段', () => {
    const { fields, parseStatus } = parseSubmissionText('主播做个能抽奖的小程序吧');
    expect(parseStatus).toBe('unparsed');
    expect(fields.title).toBeNull();
  });

  it('兼容半角分隔符、“三”与“什么”写法', () => {
    const { fields } = parseSubmissionText('投稿|想做什么:天气卡片|最希望先做哪三件事:1.定位 2.七日预报 3.穿衣建议');
    expect(fields.title).toBe('天气卡片');
    expect(fields.viewerPriorities).toEqual(['定位', '七日预报', '穿衣建议']);
  });

  it('观众优先项按原文数量保留，不强行截成三项', () => {
    expect(splitFeatureList('a、b、c、d')).toEqual(['a', 'b', 'c', 'd']);
  });
});
