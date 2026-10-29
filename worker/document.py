"""Build semantic question blocks without concatenating physical source lines."""
from __future__ import annotations

import re
import uuid
import unicodedata
from difflib import SequenceMatcher

CATEGORIES = ('选择题', '填空题', '判断题', '应用题')


def stable_id(source_id, suffix):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(source_id) + ':' + suffix))


def explicit_math(text):
    """Mark an unambiguous formula row without rewriting any printed symbol."""
    if '$' not in text and not re.search(r'[\u3400-\u9fff]', text) and re.search(r'\\[A-Za-z]+|[\^_=]', text):
        return '$' + text + '$'
    return text


def normalize_options(options):
    """Accept explicit printed A/B/C/D markers without inventing a choice."""
    if not isinstance(options, list) or len(options) > 8:
        raise ValueError('选择项格式无效。')
    result = []
    for position, option in enumerate(options):
        if isinstance(option, str):
            match = re.fullmatch(r'\s*(?:([A-Ha-hＡ-Ｈａ-ｈ])(?:\s*[.．、:：]\s*|\s+)'
                                 r'|[（(]\s*([A-Ha-hＡ-Ｈａ-ｈ])\s*[)）]\s*[.．、:：]?\s*)(.+?)\s*', option)
            label, text = ((match[1] or match[2]), match[3]) if match else ('', '')
        elif isinstance(option, dict):
            label, text = option.get('label'), option.get('text')
        else:
            label, text = '', ''
        marker = unicodedata.normalize('NFKC', label).strip() if isinstance(label, str) else ''
        match = re.fullmatch(r'(?:([A-Ha-h])|\(\s*([A-Ha-h])\s*\))\s*[.、:：]?', marker)
        canonical = (match[1] or match[2]).upper() if match else ''
        if canonical != chr(65 + position) or not isinstance(text, str) or not text.strip() or len(text) > 16000:
            raise ValueError('选择项没有识别完整，请重试。')
        result.append({'label': canonical, 'text': explicit_math(text.strip())})
    return result


def restore_subquestion_ownership(questions, printed_main_ids):
    """Recover parts split from an explicit heading or the same source number.

    Keep explicit new main numbers and category changes as hard boundaries.
    Restarting (1) after an existing part is also a boundary; no guessed parent
    is introduced when a screenshot begins with a cropped subquestion.
    """
    output = []
    for question in sorted(questions, key=lambda value: value['top']):
        parent = output[-1] if output else None
        first = question['blocks'][0]
        label = re.fullmatch(r'[（(](\d{1,3})[)）]', first.get('label', ''))
        parts = [int(match[1]) for block in parent['blocks']
                 if (match := re.fullmatch(r'[（(](\d{1,3})[)）]', block.get('label', '')))] if parent else []
        continues = (parent is not None and label is not None
                     and question['id'] not in printed_main_ids
                     and question['category'] == parent['category'] != '选择题'
                     and (parent['blocks'][0].get('role') == 'heading'
                          or question['originalNumber'] == parent['originalNumber'])
                     and int(label[1]) > max(parts, default=0)
                     and all(block['type'] == 'text' for block in question['blocks']))
        if continues:
            row = sum(block['type'] == 'text' for block in parent['blocks'])
            for block in question['blocks']:
                block['rowId'] = row
                row += 1
            parent['blocks'].extend(question['blocks'])
        else:
            output.append(question)
    return output


def align_source_rows(questions, hints):
    """Merge only adjacent blocks independently located on one printed row."""
    def signature(text):
        text = re.sub(r'\\[A-Za-z]+', '', unicodedata.normalize('NFKC', text))
        text = re.sub(r'^\d+\s*[.、]\s*', '', text)
        return ''.join(re.findall(r'[\u3400-\u9fffA-Za-z0-9]', text)).lower()
    located = [dict(hint) for hint in hints if isinstance(hint.get('text'), str) and len(hint.get('bbox', [])) == 4 and hint.get('confidence', 0) >= .8]
    rows = []
    for hint in sorted(located, key=lambda value: (sum(value['bbox'][1::2]) / 2, value['bbox'][0])):
        x1, y1, x2, y2 = hint['bbox']
        center, height = (y1 + y2) / 2, y2 - y1
        row = next((row for row in rows if abs(row['center'] - center) <= max(3, min(row['height'], height) * .35)), None)
        if row is None:
            row = {'index': len(rows), 'center': center, 'height': height}
            rows.append(row)
        hint['_physicalRow'] = row['index']
    unmatched = 0
    claimed = set()
    for question in questions:
        output = []
        for block in question['blocks']:
            if block['type'] != 'text':
                output.append(block)
                continue
            printed = block.get('label', '') + block['text']
            key = signature(printed)
            candidates = []
            for index, hint in enumerate(located):
                if index in claimed:
                    continue
                score = SequenceMatcher(None, key, signature(hint['text'])).ratio()
                if score >= .82 and (len(key) >= 4 or block['role'] == 'heading'):
                    candidates.append((score, index, hint))
            if not candidates:
                unmatched += 1
                output.append(block)
                continue
            _, index, hint = max(candidates, key=lambda item: item[0])
            claimed.add(index)
            block.update(rowId='source-' + str(hint['_physicalRow']), sourceRowId=hint['_physicalRow'], sourceBBox=list(hint['bbox']))
            previous = output[-1] if output else None
            if previous and previous['type'] == 'text' and previous.get('sourceRowId') == block['sourceRowId']:
                left, right = previous['sourceBBox'], block['sourceBBox']
                gap = max(0, right[0] - left[2])
                spaces = max(2, min(8, round(gap / max(1, (right[3] - right[1]) * .45))))
                previous['text'] = previous.pop('label', '') + previous['text'] + ' ' * spaces + printed
                previous['role'] = 'paragraph'
                previous['sourceBBox'] = [min(left[0], right[0]), min(left[1], right[1]), max(left[2], right[2]), max(left[3], right[3])]
            else:
                output.append(block)
        question['blocks'] = output
    return ['部分文字行未可靠定位，已保留识别行序，请对照原图校对。'] if unmatched else []


def questions_from_model(data, source_id):
    raw = data.get('questions')
    if not isinstance(raw, list) or not 1 <= len(raw) <= 30:
        raise ValueError('没有识别到完整题目，请使用清晰截图重试。')
    questions, printed_main_ids = [], set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not isinstance(item.get('lines'), list):
            raise ValueError('题目的原行结构不完整，请重试。')
        lines = []
        for line in item['lines']:
            if not isinstance(line, str) or len(line) > 16000:
                raise ValueError('识别的题文行无效。')
            # JSON escaped newlines are real line boundaries, never spaces.
            lines.extend(part.strip() for part in line.splitlines() if part.strip())
        if not lines or len(lines) > 100:
            raise ValueError('没有完整题文行。')
        original_number = str(item.get('number') or index + 1)
        printed_main = re.match(r'^\d{1,3}\s*[.．、](?!\d)', lines[0])
        lines[0] = re.sub(r'^' + re.escape(original_number) + r'\s*[.．、]\s*', '', lines[0], count=1)
        options = item.get('options', [])
        normalized_options = normalize_options(options)
        category = item.get('category')
        if normalized_options:
            category = '选择题'
        elif category not in CATEGORIES or category == '选择题':
            category = '填空题' if any(re.search(r'_{2,}|＿{2,}', line) for line in lines) else '应用题'
        question_id = stable_id(source_id, f'question:{index}')
        if printed_main:
            printed_main_ids.add(question_id)
        blocks = []
        for row, line in enumerate(lines):
            block = {'id': stable_id(question_id, f'row:{row}'), 'type': 'text', 'role': 'paragraph', 'text': line, 'rowId': row}
            label = re.match(r'^([（(]\d{1,3}[)）])\s*(.*)$', line)
            if label:
                block.update(role='subquestion', label=label[1], text=explicit_math(label[2]))
            elif re.fullmatch(r'(?:计算|求值|化简|解答)\s*[:：]?', line):
                block['role'] = 'heading'
            else:
                block['text'] = explicit_math(line)
            blocks.append(block)
        columns = item.get('optionColumns', min(4, len(options)) or 1)
        if not isinstance(columns, int) or not 1 <= columns <= 4:
            columns = min(4, len(options)) or 1
        if normalized_options:
            blocks.append({'id': stable_id(question_id, 'options'), 'type': 'options', 'columns': columns, 'items': normalized_options})
        top = item.get('top', index * 1000 / len(raw))
        if not isinstance(top, (int, float)) or not 0 <= top <= 1000:
            top = index * 1000 / len(raw)
        questions.append({'id': question_id, 'sourceId': source_id, 'originalNumber': original_number,
                          'category': category, 'blocks': blocks, 'figures': [], 'top': top,
                          'figurePlacement': 'afterOptions' if item.get('figurePlacement') == 'afterOptions' else 'beforeOptions'})
    return restore_subquestion_ownership(questions, printed_main_ids)
