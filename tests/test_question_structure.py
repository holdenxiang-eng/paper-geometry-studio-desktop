"""Keep source parent questions when a transcription splits off their parts."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'worker'))
from document import questions_from_model


def item(number, top, lines, category='应用题'):
    return {'number': number, 'top': top, 'category': category, 'lines': lines, 'options': []}


class QuestionStructureTests(unittest.TestCase):
    def test_split_calculation_parts_remain_inside_original_third_question(self):
        source = {'questions': [
            item('1', 20, ['先化简，再求值：$1+3/(x-1)$。']),
            item('2', 240, ['先化简，然后选择一个合适的数代入求值。']),
            item('3', 520, ['计算：']),
            item('4', 590, [r'(1)$|-5|+(-2026)^0-\sqrt{4}$']),
            item('5', 680, [r'(2)$\frac{3a}{2a-1}-\frac{a+1}{2a-1}$']),
        ]}
        questions = questions_from_model(source, 'full-page')
        self.assertEqual([q['originalNumber'] for q in questions], ['1', '2', '3'])
        blocks = questions[2]['blocks']
        self.assertEqual([block.get('label') for block in blocks], [None, '(1)', '(2)'])
        self.assertEqual([block['role'] for block in blocks], ['heading', 'subquestion', 'subquestion'])
        self.assertEqual([block['rowId'] for block in blocks], [0, 1, 2])
        self.assertEqual(blocks[1]['text'], r'$|-5|+(-2026)^0-\sqrt{4}$')
        self.assertEqual(blocks[2]['text'], r'$\frac{3a}{2a-1}-\frac{a+1}{2a-1}$')

    def test_original_top_order_and_inline_subquestion_row_are_preserved(self):
        source = {'questions': [item('3', 600, ['(1)求证：AE=BD；   (2)求角度。']),
                                item('3', 400, ['如图，已知三角形。']),
                                item('4', 800, ['4. 计算：', '(1)$x+1$', '(2)$x-1$'])]}
        questions = questions_from_model(source, 'rows')
        self.assertEqual([q['originalNumber'] for q in questions], ['3', '4'])
        self.assertEqual(len(questions[0]['blocks']), 2)
        self.assertEqual(questions[0]['blocks'][1]['label'], '(1)')
        self.assertEqual(questions[0]['blocks'][1]['text'], '求证：AE=BD；   (2)求角度。')
        self.assertEqual(questions[1]['blocks'][0]['text'], '计算：')

    def test_explicit_new_main_number_is_not_swallowed(self):
        source = {'questions': [item('3', 100, ['计算：', '(1)$x+1$']),
                                item('4', 400, ['4. (1)$x-1$', '(2)$x+2$'])]}
        questions = questions_from_model(source, 'main-numbers')
        self.assertEqual(len(questions), 2)
        self.assertEqual([q['originalNumber'] for q in questions], ['3', '4'])

    def test_new_main_number_in_metadata_can_start_directly_with_a_subquestion(self):
        source = {'questions': [item('2', 100, ['先化简，然后代入求值。']),
                                item('3', 400, ['(1)$x-1$', '(2)$x+2$'])]}
        questions = questions_from_model(source, 'main-number-field')
        self.assertEqual([q['originalNumber'] for q in questions], ['2', '3'])

    def test_subquestion_does_not_cross_a_category_or_restart_its_sequence(self):
        source = {'questions': [item('1', 100, ['如图。', '(1)求证。']),
                                item('2', 400, ['(1)计算另一题。']),
                                item('3', 700, ['(2)填写答案：_____。'], '填空题')]}
        questions = questions_from_model(source, 'boundaries')
        self.assertEqual(len(questions), 3)
        standalone = questions_from_model({'questions': [item('1', 20, ['(1)$x+1$'])]}, 'cropped')
        self.assertEqual(len(standalone), 1)
        self.assertEqual(standalone[0]['blocks'][0]['label'], '(1)')

    def test_actual_mixed_page_string_options_preserve_the_two_categories(self):
        # Actual local-model response from the user's rectangle/triangle page.
        source = {'questions': [
            {**item('1', 0, ['如图，在长方形ABCD中，E为BC的中点，F为CD上一点，若面积比为4:1，则AB与CF的数量关系是（）']),
             'options': ['A．AB=5CF', 'B．AB=4CF', 'C．AB=3CF', 'D．AB=2CF'], 'optionColumns': 4},
            item('2', 500, ['如图，Rt△ABC中，若△BFC为等腰三角形，则AE的长为______．'], '填空题'),
        ]}
        questions = questions_from_model(source, 'mixed-original')
        self.assertEqual([q['category'] for q in questions], ['选择题', '填空题'])
        block = questions[0]['blocks'][-1]
        self.assertEqual(block['columns'], 4)
        self.assertEqual([option['label'] for option in block['items']], list('ABCD'))
        self.assertEqual([option['text'] for option in block['items']], ['$AB=5CF$', '$AB=4CF$', '$AB=3CF$', '$AB=2CF$'])

    def test_structured_labels_accept_printed_punctuation_but_reject_missing_choices(self):
        for labels in [(' A. ', 'B、', 'Ｃ．', '(D)')]:
            source = {'questions': [{**item('1', 0, ['选择正确答案。']),
                                     'options': [{'label': label, 'text': '值'} for label in labels]}]}
            options = questions_from_model(source, 'labels')[0]['blocks'][-1]['items']
            self.assertEqual([option['label'] for option in options], list('ABCD'))
        for options in [['A．一', 'B．二', 'B．三', 'D．四'], ['A．一', 'C．三'], ['A．'], ['没有选项标记']]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                questions_from_model({'questions': [{**item('1', 0, ['选择正确答案。']), 'options': options}]}, 'invalid')


if __name__ == '__main__':
    unittest.main()
