// Arrows and dots for "Slider" groups. Without this script a slider still scrolls and snaps.
document.querySelectorAll('.is-style-c2t-slider').forEach((track) => {
	const slides = [...track.children];
	if (slides.length < 2) return;
	const wrap = document.createElement('div');
	wrap.className = 'c2t-slider';
	track.before(wrap);
	wrap.append(track);
	const step = () => slides[1].offsetLeft - slides[0].offsetLeft || track.clientWidth;
	const go = (left) => track.scrollTo({ left, behavior: 'smooth' });
	const arrow = (dir, label) => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = `c2t-slider__arrow c2t-slider__arrow--${dir}`;
		b.setAttribute('aria-label', label);
		b.addEventListener('click', () => go(track.scrollLeft + (dir === 'next' ? 1 : -1) * step()));
		wrap.append(b);
		return b;
	};
	const prev = arrow('prev', 'Previous slide');
	const next = arrow('next', 'Next slide');
	const dots = document.createElement('div');
	dots.className = 'c2t-slider__dots';
	wrap.append(dots);
	const pages = () => Math.max(1, Math.round((track.scrollWidth - track.clientWidth) / step()) + 1);
	const draw = () => {
		const n = pages();
		wrap.classList.toggle('is-static', n < 2);
		if (dots.children.length !== n) {
			dots.replaceChildren(...Array.from({ length: n }, (_, i) => {
				const d = document.createElement('button');
				d.type = 'button';
				d.setAttribute('aria-label', `Go to slide ${i + 1}`);
				d.addEventListener('click', () => go(i * step()));
				return d;
			}));
		}
		const at = Math.round(track.scrollLeft / step());
		[...dots.children].forEach((d, i) => d.setAttribute('aria-current', String(i === at)));
		prev.disabled = track.scrollLeft <= 2;
		next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 2;
	};
	let queued = false;
	const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
	track.addEventListener('scroll', later, { passive: true });
	window.addEventListener('resize', later);
	draw();
});
