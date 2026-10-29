from reader_next_api.web_search import parse_search_results


def test_search_result_parser_extracts_real_url_and_snippet():
    html = '''
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.edu%2Fpaper">专业论文</a>
    <a class="result__snippet">来自高校的专业摘要</a>
    '''

    assert parse_search_results(html) == [{
        "title": "专业论文",
        "url": "https://example.edu/paper",
        "snippet": "来自高校的专业摘要",
    }]
