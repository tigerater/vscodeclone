/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseLinkedText } from 'vs/base/browser/linkedText';

suite('LinkedText', () => {
	test('parses correctly', () => {
		assert.deepEqual(parseLinkedText(''), []);
		assert.deepEqual(parseLinkedText('hello'), ['hello']);
		assert.deepEqual(parseLinkedText('hello there'), ['hello there']);
		assert.deepEqual(parseLinkedText('Some message with [link text](http://link.href).'), [
			'Some message with ',
			{ label: 'link text', href: 'http://link.href' },
			'.'
		]);
		assert.deepEqual(parseLinkedText('Some message with [link text](http://link.href "and a title").'), [
			'Some message with ',
			{ label: 'link text', href: 'http://link.href', title: 'and a title' },
			'.'
		]);
		assert.deepEqual(parseLinkedText('Some message with [link text](random stuff).'), [
			'Some message with [link text](random stuff).'
		]);
		assert.deepEqual(parseLinkedText('Some message with [https link](https://link.href).'), [
			'Some message with ',
			{ label: 'https link', href: 'https://link.href' },
			'.'
		]);
		assert.deepEqual(parseLinkedText('Some message with [https link](https:).'), [
			'Some message with [https link](https:).'
		]);
		assert.deepEqual(parseLinkedText('Some message with [a command](command:foobar).'), [
			'Some message with ',
			{ label: 'a command', href: 'command:foobar' },
			'.'
		]);
		assert.deepEqual(parseLinkedText('Some message with [a command](command:).'), [
			'Some message with [a command](command:).'
		]);
		assert.deepEqual(parseLinkedText('link [one](command:foo "nice") and link [two](http://foo)...'), [
			'link ',
			{ label: 'one', href: 'command:foo', title: 'nice' },
			' and link ',
			{ label: 'two', href: 'http://foo' },
			'...'
		]);
		assert.deepEqual(parseLinkedText('link\n[one](command:foo "nice")\nand link [two](http://foo)...'), [
			'link\n',
			{ label: 'one', href: 'command:foo', title: 'nice' },
			'\nand link ',
			{ label: 'two', href: 'http://foo' },
			'...'
		]);
	});
});
