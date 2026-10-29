"""Opt-in real local-model acceptance; never run by unit-test discovery."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


class Client:
    def __init__(self):
        self.messages = queue.Queue()
        self.responses = {}
        self.started = time.monotonic()
        self.process = subprocess.Popen([str(ROOT / 'dist/resources/python/python.exe'), '-X', 'utf8', '-u', str(ROOT / 'worker/service.py')],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding='utf-8', cwd=ROOT,
                                        env={**os.environ, 'PAPER_STUDIO_RESOURCE_DIR': str(ROOT / 'dist/resources')})
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._errors, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                print('NON_PROTOCOL_STDOUT', line[:300], flush=True)

    def _errors(self):
        for line in self.process.stderr:
            print('WORKER', line.rstrip(), flush=True)

    def send(self, request_id, method, **params):
        self.process.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params}, ensure_ascii=False) + '\n')
        self.process.stdin.flush()

    def response(self, request_id, timeout=165):
        end = time.monotonic() + timeout
        while request_id not in self.responses:
            self.read(max(.01, end - time.monotonic()))
        return self.responses[request_id]

    def read(self, timeout):
        message = self.messages.get(timeout=timeout)
        elapsed = round(time.monotonic() - self.started, 3)
        if message.get('type') == 'response':
            self.responses[message['id']] = message
            print(elapsed, 'RESPONSE', message['id'], 'ok=' + str(message['ok']), message.get('error', ''), flush=True)
        elif message.get('event') == 'job':
            print(elapsed, 'JOB', message['jobId'], message['stage'], flush=True)
            if message['stage'] == 'text-ready':
                print(json.dumps(message['questions'], ensure_ascii=False), flush=True)
        else:
            print(elapsed, 'EVENT', json.dumps(message, ensure_ascii=False), flush=True)
        return message

    def stage(self, job_id, stage, timeout=30):
        end = time.monotonic() + timeout
        while True:
            message = self.read(max(.01, end - time.monotonic()))
            if message.get('jobId') == job_id and message.get('stage') == stage:
                return

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        print('WORKER_EXIT', self.process.returncode, flush=True)


def image_url(path, crop=None):
    from PIL import Image
    image = Image.open(path)
    if crop:
        image = image.crop(crop)
    output = io.BytesIO()
    image.save(output, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['math3', 'rational', 'geometry', 'cancellation', 'parallel', 'mixed', 'parentpage'], default='math3')
    parser.add_argument('--source-image', type=Path, help='Original local screenshot for mixed/parentpage acceptance')
    parser.add_argument('--raster', type=Path, help='Actual browser preprocessing result for the source image')
    parser.add_argument('--output', type=Path, help='Save the recognized document for preview/export acceptance')
    args = parser.parse_args()
    fixtures = ROOT.parent / 'tests/fixtures'
    client = Client()
    try:
        client.send('status', 'status')
        state = client.response('status', timeout=5)
        assert state['ok'] and state['result']['recognition']['state'] == 'idle'
        if args.source_image:
            image = image_url(args.source_image)
        elif args.case in {'math3', 'mixed', 'parentpage'}:
            if not args.source_image:
                parser.error('--source-image is required for math3/mixed/parentpage')
        elif args.case == 'rational':
            image = image_url(fixtures / 'recognition-rational-expressions.png')
        elif args.case == 'geometry':
            image = image_url(fixtures / 'recognition-three-captions.png')
        else:
            image = image_url(fixtures / 'recognition-single-unlabeled.png')
        raster = json.loads(args.raster.read_text('utf-8')) if args.raster else {}
        if args.case == 'geometry':
            from PIL import Image
            original = Image.open(fixtures / 'recognition-three-captions.png')
            raster = {'height': original.height, 'regions': [
                {'x': crop[0], 'y': crop[1], 'width': crop[2]-crop[0], 'height': crop[3]-crop[1], 'cropDataUrl': image_url(fixtures / 'recognition-three-captions.png', crop)}
                for crop in [(18, 112, 164, 253), (167, 112, 310, 253), (313, 112, 459, 253)]]}
        source_id = 'integration-' + args.case if args.case in {'mixed', 'parentpage'} else 'integration-source'
        client.send('recognize', 'recognize', jobId='integration', sourceId=source_id, imageDataUrl=image, raster=raster)
        if args.case == 'cancellation':
            client.stage('integration', 'text')
            client.send('other', 'recognize', jobId='second', sourceId='second-source', imageDataUrl=image)
            client.send('cancel', 'cancel', jobId='integration')
            assert client.response('cancel', timeout=3)['ok']
            assert client.response('recognize', timeout=3)['error']['code'] == 'CANCELLED'
            result = client.response('other')
        elif args.case == 'parallel':
            second = image_url(fixtures / 'recognition-rational-expressions.png')
            client.send('other', 'recognize', jobId='second', sourceId='second-source', imageDataUrl=second)
            result = client.response('recognize')
            assert client.response('other')['ok'], client.responses['other']
            assert client.responses['other']['result']['questions'][0]['sourceId'] == 'second-source'
        else:
            result = client.response('recognize')
        assert result['ok'], result
        print(json.dumps(result['result'], ensure_ascii=False), flush=True)
        questions = result['result']['questions']
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result['result'], ensure_ascii=False, indent=2), encoding='utf-8')
        if args.case == 'mixed':
            assert len(questions) == 2, questions
            assert [question['category'] for question in questions] == ['选择题', '填空题'], questions
            options = next(block for block in questions[0]['blocks'] if block['type'] == 'options')
            assert [option['label'] for option in options['items']] == list('ABCD'), options
            assert options['columns'] == 4, options
            assert not any(block['type'] == 'options' for block in questions[1]['blocks']), questions[1]
            if raster.get('regions'):
                assert [reading['questionIndex'] for reading in result['result']['figureReadings']] == [0, 1], result['result']['figureReadings']
                assert [set(reading['labels']) for reading in result['result']['figureReadings']] == [set('ABCDEF'), set('ABC')], result['result']['figureReadings']
        if args.case == 'parentpage':
            assert len(questions) == 3, questions
            assert [question['originalNumber'] for question in questions] == ['1', '2', '3'], questions
            assert questions[2]['blocks'][0]['role'] == 'heading', questions[2]
            assert [block.get('label') for block in questions[2]['blocks']] == [None, '(1)', '(2)'], questions[2]
            assert r'\sqrt{4}' in questions[2]['blocks'][1]['text'], questions[2]
            assert r'\dfrac' in questions[2]['blocks'][2]['text'] or r'\frac' in questions[2]['blocks'][2]['text'], questions[2]
            assert '$' in questions[0]['blocks'][0]['text'] and '$' in questions[1]['blocks'][0]['text'], questions
        if args.case == 'math3':
            assert len(questions) == 1
            blocks = questions[0]['blocks']
            assert len(blocks) == 3 and blocks[0]['role'] == 'heading', blocks
            assert [block.get('label') for block in blocks] == [None, '(1)', '(2)'], blocks
            assert '-5' in blocks[1]['text'] and '2026' in blocks[1]['text'] and r'\sqrt' in blocks[1]['text'], blocks
            assert '3a' in blocks[2]['text'] and '2a-1' in blocks[2]['text'].replace(' ', ''), blocks
        if args.case == 'rational':
            assert len(questions) == 1 and len(questions[0]['blocks']) == 5, questions
        if args.case == 'geometry':
            readings = result['result']['figureReadings']
            assert [row['regionIndex'] for row in readings] == [0, 1, 2]
            assert [set(row['labels']) for row in readings] == [set('ABCDE'), set('ABCDE'), set('ABCDEF')], readings
            assert all(row['lengthLabels'] == [] for row in readings), readings
            assert len(questions[0]['blocks']) == 3, questions
            assert '(1)' in questions[0]['blocks'][2]['text'] and '(2)' in questions[0]['blocks'][2]['text'], questions
        print('ACCEPTANCE_PASS', args.case, flush=True)
    finally:
        client.close()


if __name__ == '__main__':
    main()
