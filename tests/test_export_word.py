"""New document-block exporter: inspect genuine DOCX XML, never a mock writer."""
import base64
import copy
import importlib.util
from io import BytesIO
from pathlib import Path
import struct
import unittest
import xml.etree.ElementTree as ET
from zipfile import ZipFile
import zlib

spec = importlib.util.spec_from_file_location('next_word', Path(__file__).resolve().parents[1] / 'worker/export_word.py')
word = importlib.util.module_from_spec(spec)
spec.loader.exec_module(word)
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
      'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}


def question(blocks, category='应用题', **values):
    return {'id': 'q', 'category': category, 'blocks': blocks, 'figures': [], **values}


def paragraph(content, role='paragraph', label=None):
    return {'id': 'b' + str(len(content)), 'type': 'text', 'role': role, 'text': content, **({'label': label} if label else {})}


def document(questions, **params):
    result = word.export_word({'project': {'version': 3, 'title': '数学练习', 'sources': [], 'questions': questions}, **params})
    data = base64.b64decode(result['dataBase64'], validate=True)
    assert data.startswith(b'PK')
    with ZipFile(BytesIO(data)) as archive:
        return result, ET.fromstring(archive.read('word/document.xml')), archive.read('word/document.xml').decode()


def png(width=1000, height=300):
    def chunk(name, data):
        return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + b'\xff' * width * 3) * height)) + chunk(b'IEND', b'')


class WordExport(unittest.TestCase):
    def test_heading_and_subquestions_remain_three_native_word_paragraphs(self):
        blocks = [paragraph('计算：', 'heading'), paragraph(r'$\left|-5\right|+\left(-2026\right)^0-\sqrt{4}$', 'subquestion', '(1)'),
                  paragraph(r'$\dfrac{3a}{2a-1}-\dfrac{a+1}{2a-1}$', 'subquestion', '(2)')]
        result, root, xml = document([question(blocks)])
        values = [''.join(p.itertext()) for p in root.findall('./w:body/w:p', NS)]
        heading = next(i for i, text in enumerate(values) if text == '1、计算：')
        self.assertTrue(values[heading + 1].startswith('(1)'))
        self.assertTrue(values[heading + 2].startswith('(2)'))
        self.assertEqual(len(root.findall('.//m:oMath', NS)), 2)
        self.assertEqual(len(root.findall('.//m:f', NS)), 2)
        self.assertEqual(len(root.findall('.//m:rad', NS)), 1)
        self.assertTrue(any(''.join(node.itertext()) == '0' for node in root.findall('.//m:sSup/m:sup', NS)))
        self.assertTrue(any(node.get('{%s}val' % NS['m']) == '|' for node in root.findall('.//m:begChr', NS)))
        self.assertFalse(any(command in xml for command in [r'\left', r'\sqrt', r'\dfrac']))
        self.assertEqual(result['mimeType'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

    def test_four_rational_expressions_stay_editable_without_source_fallback(self):
        expressions = [r'\left(\dfrac{a^3}{-2b}\right)^2\div\left(-\dfrac{a^2}{b}\right)^3\cdot\left(\dfrac{b}{2}\right)^2',
                       r'\dfrac{a^2-1}{a^2+4a+4}\div\dfrac{a+1}{a+2}', r'\dfrac{x^2}{x+1}-x+1',
                       r'\dfrac{x+3}{2x-4}\div\left(\dfrac{5}{x-2}-x-2\right)']
        _, root, xml = document([question([paragraph('计算：', 'heading')] + [paragraph('$' + value + '$', 'subquestion', f'({i+1})') for i, value in enumerate(expressions)])])
        self.assertEqual(len(root.findall('.//m:oMath', NS)), 4)
        self.assertEqual(len(root.findall('.//m:f', NS)), 8)
        self.assertEqual(len(root.findall('.//m:sSup', NS)), 8)
        self.assertNotIn(r'\dfrac', xml)

    def test_categories_numbers_and_answer_spaces_match_the_shared_document_rule(self):
        questions = [question([paragraph('证明')], id='a'), question([paragraph('选一')], '选择题', id='c1'),
                     question([paragraph('选二')], '选择题', id='c2'), question([paragraph('____')], '填空题', id='f'),
                     question([paragraph('不留答题区')], id='a2', answerSpaceMm=0)]
        _, root, xml = document(questions)
        texts = [''.join(p.itertext()) for p in root.findall('./w:body/w:p', NS)]
        self.assertLess(texts.index('一、选择题'), texts.index('二、填空题'))
        self.assertLess(texts.index('二、填空题'), texts.index('三、应用题'))
        self.assertIn('1、选一', texts)
        self.assertIn('2、选二', texts)
        self.assertIn('1、____', texts)
        spaces = [node for node in root.findall('.//w:spacing', NS) if node.get('{%s}line' % NS['w']) == '1361']
        self.assertEqual(len(spaces), 1)
        self.assertEqual(spaces[0].get('{%s}lineRule' % NS['w']), 'exact')
        self.assertNotIn('pBdr', xml)

    def test_image_block_order_and_option_columns_are_preserved_without_extra_captions(self):
        blocks = [paragraph('原图顺序'), {'id': 'drawing', 'type': 'figures', 'figureIds': ['f1', 'f2']},
                  {'id': 'answers', 'type': 'options', 'columns': 4, 'items': [{'label': chr(65+i), 'text': str(i)} for i in range(4)]}]
        q = question(blocks, '选择题', figures=[{'id': 'f1', 'caption': ''}, {'id': 'f2', 'caption': '图2'}])
        group = {'drawing': {'dataBase64': base64.b64encode(png()).decode(), 'widthPx': 1000, 'heightPx': 300}}
        _, root, xml = document([q], figureGroups=group)
        children = list(root.find('w:body', NS))
        picture = next(i for i, node in enumerate(children) if node.find('.//w:drawing', NS) is not None)
        table = next(i for i, node in enumerate(children) if node.tag.endswith('}tbl'))
        self.assertLess(picture, table)
        self.assertEqual(len(children[table].findall('./w:tr/w:tc', NS)), 4)
        extent = root.find('.//wp:extent', NS)
        self.assertEqual(int(extent.get('cx')), 6120000)
        self.assertNotIn('题图', xml)
        self.assertNotIn('提图', xml)
        q['blocks'] = [blocks[0], blocks[2], blocks[1]]
        _, other, _ = document([q], figureGroups=group)
        ordered = list(other.find('w:body', NS))
        self.assertLess(next(i for i, node in enumerate(ordered) if node.tag.endswith('}tbl')), next(i for i, node in enumerate(ordered) if node.find('.//w:drawing', NS) is not None))

    def test_invalid_or_unknown_math_and_missing_images_stop_export_explicitly(self):
        for content in [r'$\notARealCommand{x}$', r'$\frac{a}{', r'\frac{a}{b}']:
            with self.subTest(content=content), self.assertRaisesRegex(ValueError, '公式|校对'):
                document([question([paragraph(content)])])
        with self.assertRaisesRegex(ValueError, '图形'):
            document([question([{'id': 'missing', 'type': 'figures', 'figureIds': ['f']}])])
        with self.assertRaisesRegex(ValueError, '题目'):
            document([])

    def test_text_is_xml_safe_and_filename_does_not_escape(self):
        params = {'project': {'version': 3, 'title': '../<数学>&试卷', 'sources': [], 'questions': [question([paragraph('<script>&原文')])]}}
        result = word.export_word(params)
        self.assertNotIn('/', result['fileName'])
        with ZipFile(BytesIO(base64.b64decode(result['dataBase64']))) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
        self.assertIn('<script>&原文', ''.join(root.itertext()))


if __name__ == '__main__':
    unittest.main()
