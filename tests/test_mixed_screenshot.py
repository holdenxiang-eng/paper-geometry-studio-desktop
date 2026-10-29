"""A screenshot can contain questions from different sections and diagrams."""
import copy
from pathlib import Path
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'worker'))
from service import Service, TRANSCRIBE, VISUAL


IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII='


def mixed_transcript():
    return {'questions': [
        {'number': '1', 'top': 30, 'category': '选择题',
         'lines': ['如图，在长方形ABCD中，E为BC的中点，F为CD上一点，若面积比为4:1，则AB与CF的数量关系是（ ）'],
         'options': [label + '．AB=' + str(5 - index) + 'CF' for index, label in enumerate('ABCD')],
         'optionColumns': 4, 'figurePlacement': 'beforeOptions'},
        {'number': '2', 'top': 620, 'category': '填空题',
         'lines': ['如图，Rt△ABC中，∠ACB=90°，AC=4，BC=3，求AE的长为____。'],
         'options': [], 'figurePlacement': 'beforeOptions'}]}


class MixedScreenshotTests(unittest.TestCase):
    def run_transcript(self, raw):
        messages, done, prompts = [], threading.Event(), []
        class Engine:
            def status(self): return {'state': 'ready', 'available': True}
            def wait(self, job): job.check()
            def request(self, prompt, image, job, deadline, max_tokens=1700):
                job.check()
                prompts.append(prompt)
                return {'labels': ['A', 'B', 'C'], 'lengthLabels': []} if prompt == VISUAL else copy.deepcopy(raw)
            def close(self): pass
        class Boxes:
            def read(self, data, job): job.check(); return []
        def emit(value):
            messages.append(value)
            if value['type'] == 'response': done.set()
        service = Service(emit, engine=Engine(), boxes=Boxes())
        try:
            service.dispatch({'id': 'mixed', 'method': 'recognize', 'params': {
                'jobId': 'mixed', 'sourceId': 'same-screenshot', 'imageDataUrl': IMAGE,
                'raster': {'height': 1000, 'regions': [
                    {'y': 170, 'cropDataUrl': IMAGE}, {'y': 790, 'cropDataUrl': IMAGE}]}}})
            self.assertTrue(done.wait(4), 'worker did not answer the screenshot')
            return next(value for value in messages if value['type'] == 'response'), prompts
        finally:
            service.close()

    def test_mixed_categories_and_printed_option_markers_keep_both_questions(self):
        response, prompts = self.run_transcript(mixed_transcript())
        self.assertTrue(response['ok'], response.get('error'))
        result = response['result']
        self.assertEqual([q['category'] for q in result['questions']], ['选择题', '填空题'])
        self.assertEqual([q['originalNumber'] for q in result['questions']], ['1', '2'])
        self.assertTrue(all(q['sourceId'] == 'same-screenshot' for q in result['questions']))
        options = next(block for block in result['questions'][0]['blocks'] if block['type'] == 'options')
        self.assertEqual(options['columns'], 4)
        self.assertEqual([item['label'] for item in options['items']], list('ABCD'))
        self.assertEqual(result['questions'][0]['figurePlacement'], 'beforeOptions')
        self.assertFalse(any(block['type'] == 'options' for block in result['questions'][1]['blocks']))
        self.assertEqual([item['questionIndex'] for item in result['figureReadings']], [0, 1])
        self.assertEqual(prompts.count(TRANSCRIBE), 1, 'mixed sections must not add a second full-image pass')

    def test_genuinely_duplicate_options_still_fail_without_inventing_missing_choices(self):
        raw = mixed_transcript()
        raw['questions'][0]['options'][2] = 'B．AB=3CF'
        response, _ = self.run_transcript(raw)
        self.assertFalse(response['ok'])
        self.assertIn('选择', response['error']['message'])

    def test_structured_options_with_printed_punctuation_are_accepted_too(self):
        raw = mixed_transcript()
        raw['questions'][0]['options'] = [{'label': label + '.', 'text': 'AB=' + str(5 - index) + 'CF'} for index, label in enumerate('ABCD')]
        response, _ = self.run_transcript(raw)
        self.assertTrue(response['ok'], response.get('error'))


if __name__ == '__main__':
    unittest.main()
