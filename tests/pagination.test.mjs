import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('categories appear once while question order survives continuation pages and reflow', { timeout: 20000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>
    #pages { width: 210px; }
    .paper-page-body { height: 200px; }
    h2 { height: 20px; line-height: 20px; margin: 0; font-size: 12px; }
    .question { height: 80px; margin: 0; }
  </style><main id="pages"></main>`);
  const source = await readFile(new URL('../ui/core/pagination.js', import.meta.url), 'utf8');
  await page.evaluate(async source => {
    const { createPaperPagination } = await import('data:text/javascript,' + encodeURIComponent(source));
    const names = ['选择题', '填空题', '判断题', '应用题'];
    const numerals = ['一', '二', '三', '四'];
    window.groups = names.map((category, groupIndex) => {
      const heading = document.createElement('h2');
      heading.dataset.category = category; heading.textContent = `${numerals[groupIndex]}、${category}`;
      const questions = Array.from({ length: groupIndex === 2 ? 3 : 5 }, (_, index) => {
        const node = document.createElement('article'); node.className = 'question';
        node.dataset.questionId = `${groupIndex}-${index}`; node.textContent = `${index + 1}、正文`;
        return node;
      });
      return { category, title: heading.textContent, heading, questions };
    });
    window.pagination = createPaperPagination(document.querySelector('#pages'));
    pagination.update(groups, '分页验收');
  }, source);
  const readPages = () => page.evaluate(() => ({
    headings: [...document.querySelectorAll('.paper-page-body h2')].map(node => node.textContent),
    questions: [...document.querySelectorAll('.question')].map(node => node.dataset.questionId),
    continuationCount: document.querySelectorAll('.paper-category-continuation').length,
    pageCount: Number(document.querySelector('#pages').dataset.pageCount),
    orphanHeadings: [...document.querySelectorAll('.paper-page-body h2')].filter(node => !node.nextElementSibling?.matches('.question')).length,
  }));
  await page.waitForFunction(() => document.querySelector('#pages').dataset.paginating === 'false');
  const before = await readPages();
  assert.ok(before.pageCount > 4, 'the fixture must actually span multiple pages per category');
  assert.deepEqual(before.headings, ['一、选择题', '二、填空题', '三、判断题', '四、应用题']);
  assert.equal(before.continuationCount, 0);
  assert.equal(before.orphanHeadings, 0);
  assert.equal(before.questions.length, 18);
  await page.evaluate(() => {
    document.querySelector('style').textContent += '.paper-page-body { height: 120px; }';
    pagination.schedule();
  });
  await page.waitForFunction(() => document.querySelector('#pages').dataset.paginating === 'false' && Number(document.querySelector('#pages').dataset.pageCount) > 9);
  const after = await readPages();
  assert.deepEqual(after.headings, before.headings);
  assert.deepEqual(after.questions, before.questions);
  assert.equal(after.continuationCount, 0);
  assert.equal(after.orphanHeadings, 0);
});
