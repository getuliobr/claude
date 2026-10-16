from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
AGENTS = sorted((ROOT / 'agents').glob('*.md'))


def frontmatter(path):
    text = path.read_text()
    if not text.startswith('---\n'):
        raise AssertionError(f'{path.name}: missing frontmatter')
    block = text[4:].split('\n---\n', 1)[0]
    return yaml.safe_load(block)


class AgentTests(unittest.TestCase):
    def test_there_are_agents(self):
        self.assertTrue(AGENTS)

    def test_frontmatter_is_valid_yaml_with_required_fields(self):
        for path in AGENTS:
            with self.subTest(agent=path.name):
                meta = frontmatter(path)
                self.assertIsInstance(meta, dict)
                self.assertEqual(meta.get('name'), path.stem)
                self.assertIsInstance(meta.get('description'), str)
                self.assertTrue(meta['description'].strip())
                if 'tools' in meta:
                    self.assertIsInstance(meta['tools'], str)


if __name__ == '__main__':
    unittest.main()
