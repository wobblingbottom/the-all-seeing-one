const form = document.querySelector('#feedback-form');
const status = document.querySelector('#submit-status');
const boardStatus = document.querySelector('#board-status');
let page = 1;
let loadId = 0;
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Please try again.');
  return data;
}
async function loadFeedback(target = page) {
  const id = ++loadId;
  boardStatus.textContent = 'Loading feedback...';
  boardStatus.classList.remove('error');
  try {
    const result = await api(`/api/feedback?page=${target}`);
    if (id !== loadId) return;
    page = result.page;
    const list = document.querySelector('#feedback-list');
    list.replaceChildren();
    for (const item of result.items) {
      const article = document.createElement('article');
      article.className = 'card';
      const meta = document.createElement('div');
      meta.className = 'feedback-meta';
      meta.textContent = `${item.type === 'bug' ? 'Bug report' : 'Suggestion'} - ${item.username} - ${new Date(item.created_at).toLocaleString()}`;
      const title = document.createElement('h3');
      title.textContent = item.title;
      const details = document.createElement('p');
      details.className = 'feedback-details';
      details.textContent = item.description;
      article.append(meta, title, details);
      list.append(article);
    }
    boardStatus.textContent = result.items.length ? '' : 'No feedback yet. Be the first to share.';
    document.querySelector('#page').textContent = `Page ${page} of ${result.totalPages}`;
    document.querySelector('#previous').disabled = page <= 1;
    document.querySelector('#next').disabled = page >= result.totalPages;
  } catch (error) {
    if (id !== loadId) return;
    boardStatus.textContent = error.message;
    boardStatus.classList.add('error');
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Submitting...';
  try {
    await api('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    status.textContent = 'Feedback submitted.';
    await loadFeedback(1);
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally { button.disabled = false; }
});
document.querySelector('#refresh').onclick = () => loadFeedback();
document.querySelector('#previous').onclick = () => loadFeedback(page - 1);
document.querySelector('#next').onclick = () => loadFeedback(page + 1);
fetch('/api/me').then(response => {
  if (response.ok) form.hidden = false;
  else if (response.status === 401) document.querySelector('#sign-in').hidden = false;
  else throw new Error('Could not check sign-in. Please refresh to try again.');
}).catch(() => { status.textContent = 'Could not check sign-in. Please refresh to try again.'; });
loadFeedback();
