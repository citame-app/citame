# Service booking design check

GATE: ERROR (third invocation exited 2 before a final report)

The last complete pass was **GATE: FAIL 33 (round 2 of 3)**. The third invocation exited with status 2 after its opening line and emitted no completed report. It was not rerun. These are the last complete findings, not a PASS declaration.

The real fixed-bar/footer collision found in the first pass was corrected and covered by a red/green production-browser regression. Mobile branding now has a 44px tap height. The complete final service matrix passes 16 cases.

This is an existing booking application, kind `place`, with the established ivory/rose palette and local Lora/Nunito Sans. It retains its catalogue and fixed/sticky booking summary. A booking step is not implemented as a marketing hero. No kit file was changed; no new waiver was added.

## Open findings

1. **no-visual** — `main#main > div.page-container.mx-auto "Elige tus servicios"` (1440, 390px). no picture, effect or mock in this section; a feature section needs a visual

2. **cta** — `main#main > div.page-container.mx-auto` (1440, 390px). the hero has no button (the nav's does not count)

3. **copy-headline** — `h1#step-title "Elige tus servicios"` (1440px). "Elige tus servicios" does not name what is sold (reservas de belleza, reservas, belleza, from flags)

4. **focus-visible** — `div.space-y-4:nth-of-type(2) > section.space-y-3:nth-of-type(1) > div.relative > input.peer.absolute "Coloración (demo)"` (1440px). Tab stop 9, input "Coloración (demo)": the focus lands on something you cannot see

5. **focus-visible** — `div.space-y-4:nth-of-type(2) > section.space-y-3:nth-of-type(2) > div.relative > input.peer.absolute "Corte y peinado (demo)"` (1440px). Tab stop 10, input "Corte y peinado (demo)": the focus lands on something you cannot see

6. **focus-visible** — `div.space-y-4:nth-of-type(2) > section.space-y-3:nth-of-type(3) > div.relative > input.peer.absolute "Diseño de cejas (demo)"` (1440px). Tab stop 11, input "Diseño de cejas (demo)": the focus lands on something you cannot see

7. **moment-none** — `(the page)` (1440px). a place page (--type) deals no moment: every kind carries one, two on a long page (moments.md)

8. **hero-screen** — `main#main > div.page-container.mx-auto "1Servicios2Profesional3Horario4Confirmac"` (1440px). the hero ends at 1117px on a 900px screen, 217px below the fold: it ends at the fold, 1px either way (SR-1)

9. **section-height** — `main#main > div.page-container.mx-auto "1Servicios2Profesional3Horario4Confirmac"` (1440px). the section starts at 65px, 65px below the screen grid (0 x 900px): sections start on whole screens (SR-2)

10. **one-section** — `main#main > div.page-container.mx-auto "1Servicios2Profesional3Horario4Confirmac"` (1440px). a <div> sits directly in <main>: every part of <main> is a <section> (SR-4)

11. **one-heading** — `div.mt-6.grid > aside.booking-summary.fixed > div.mx-auto.max-w-3xl > h2.mb-4.hidden "Tu reserva"` (1440px). the hero holds an h2 (1): its heading is the h1, and an h2 opens the next section (SR-5)

12. **container-edges** — `main#main > div.page-container.mx-auto "1Servicios2Profesional3Horario4Confirmac"` (1440px). the content of section 1 runs 168px from the left and 168px from the right (read from its outermost blocks: no .wrap): the page's container starts at 120px; the margin is 64-120px at 1440px (one container, equal margins, 2px either way) (SR-6)

13. **container-edges** — `div.relative > label.booking-choice.relative > span.min-w-0.flex-1 > span.block.font-medium "Coloración (demo)"` (1440px). 6 text blocks start on a left line at x 177, 57px from the container's left: text starts on the container's left, or on one split line (x 630, 732, 834) (also "Corte y peinado (demo)", "Diseño de cejas (demo)", "Manicura (demo)") (SR-6)

14. **container-edges** — `div.space-y-4 > section.space-y-3:nth-of-type(1) > div.relative > label.booking-choice.relative "Coloración (demo)1h 30minEUR 65"` (1440px). 6 text blocks start on a left line at x 141, 21px from the container's left: text starts on the container's left, or on one split line (x 630, 732, 834) (also "Corte y peinado (demo)45minEUR 3", "Diseño de cejas (demo)20minEUR 1", "Manicura (demo)45minEUR 25") (SR-6)

15. **split-pair** — `main#main > div.page-container.mx-auto > div.booking-frame.pt-6 > div.mt-6.grid "Elige tus serviciosSelecciona uno o más."` (1440px). the two columns of the split start 16px apart at the top: a split's columns are top-aligned, 8px either way (SR-8)

16. **edge-left** — `div.page-container.mx-auto section.booking-content.min-w-0 "Elige tus serviciosSelecciona un"` (1440px). starts at x 168; the lines are 120 and the column starts

17. **edge-right** — `div.page-container.mx-auto section.booking-content.min-w-0 "Elige tus serviciosSelecciona un"` (1440px). ends at x 888; the right line is 1320

18. **edge-left** — `header.mb-6 h1.text-title "Elige tus servicios"` (1440px). starts at x 168; the lines are 120 and the column starts

19. **edge-left** — `header.mb-6 p.mt-2.max-w-prose "Selecciona uno o más. Puedes com"` (1440px). starts at x 168; the lines are 120 and the column starts

20. **edge-left** — `div.page-container.mx-auto div "Buscar servicios"` (1440px). starts at x 168; the lines are 120 and the column starts

21. **edge-left** — `div.page-container.mx-auto div "CategoríaTodas las categorías"` (1440px). starts at x 534; the lines are 120 and the column starts

22. **edge-left** — `div.page-container.mx-auto aside.booking-summary.fixed "Tu reservaElige al menos un serv"` (1440px). starts at x 920; the lines are 120 and the column starts

23. **edge-left** — `div.page-container.mx-auto h2.mb-4.hidden "Tu reserva"` (1440px). starts at x 945; the lines are 120 and the column starts

24. **edge-left** — `div.page-container.mx-auto p.pb-3.text-muted "Elige al menos un servicio para "` (1440px). starts at x 945; the lines are 120 and the column starts

25. **edge-left** — `div.page-container.mx-auto p.flex.items-center "0 servicios"` (1440px). starts at x 945; the lines are 120 and the column starts

26. **edge-left** — `div.page-container.mx-auto p.mt-1.flex "Total—"` (1440px). starts at x 945; the lines are 120 and the column starts

27. **lines** — `page` (1440px). headings and leads start on 2 lines (x 168, 945); the page has 120 and one split line

28. **spill** — `div.page-container.mx-auto ol.flex.items-center "1Servicios2Profesional3Horario4C"` (390px). x 16 to 374, the page runs 24 to 366

29. **spill** — `div.page-container.mx-auto section.booking-content.min-w-0 "Elige tus serviciosSelecciona un"` (390px). x 16 to 374, the page runs 24 to 366

30. **spill** — `header.mb-6 h1.text-title "Elige tus servicios"` (390px). x 16 to 374, the page runs 24 to 366

31. **spill** — `header.mb-6 p.mt-2.max-w-prose "Selecciona uno o más. Puedes com"` (390px). x 16 to 374, the page runs 24 to 366

32. **spill** — `div.page-container.mx-auto div "Buscar servicios"` (390px). x 16 to 374, the page runs 24 to 366

33. **spill** — `div.page-container.mx-auto div "CategoríaTodas las categorías"` (390px). x 16 to 374, the page runs 24 to 366

## Existing waivers applied

- **focus-visible**, `input#locale-es-AR`: The native transparent radio is stretched over its visible label. Playwright verifies keyboard focus draws a solid 3px outline on both associated labels in light and dark themes; the checker evaluates the transparent input alone.

- **section-height**, `footer.closing.site-footer "Sisters of BeautyPeluquería, uñas y ceja"`: This existing booking application shares a compact navigation and illustration-credit footer across public, booking and account routes. Stretching it to a full viewport adds empty space without helping salon customers.

- **one-section**, `footer.closing.site-footer "Sisters of BeautyPeluquería, uñas y ceja"`: The shared application footer intentionally follows the closing brand section as a compact footer, rather than consuming another full marketing screen. Its links and provenance remain visible and accessible.

The existing text-only salon-close and synthetic hero-heading waivers do not match this booking route and were not applied.

## Warnings retained

- **copy-buttons**, `aside.booking-summary.fixed > div.mx-auto.max-w-3xl > div.flex.items-center > button.btn.inline-flex "Continuar"`: "Continuar" does not start with a verb (book, buy, try, start, get, see...)

- **nav-family**, `header.nav.site-header`: the nav's links come in 2 sizes (16, 14px)

- **nav-labels**, `header.nav.site-header > a.sr-only.rounded-md "Saltar al contenido principal"`: "Saltar al contenido principal" opens a section headed "Elige tus servicios"

- **share-meta**, `head`: the head lacks og:image: a shared link shows no picture or title of its own

- **section-height**, `main#main`: the page is 1.6 screens long (1431px on a 900px screen): a place page runs 3 to 6 screens (over 7 FAIL) (SR-2)

- **container-edges**, `div.mt-6.grid > aside.booking-summary.fixed > div.mx-auto.max-w-3xl > h2.mb-4.hidden "Tu reserva"`: the h2 starts 777px right of the container's left: every h1 and h2 starts on it, 2px either way (it sits in a part held on screen as the page scrolls: told as a WARN) (SR-6)

The short Continue action is the established step-navigation control. Existing brand/language controls, shared application footer and absent final public sharing domain are retained. The English composition checker does not recognise every Spanish verb. Layout findings include its marketing screen/grid rules applied to an application catalogue, its input-only evaluation of labelled native checkboxes, and different catalogue/summary columns. They remain visible in this report rather than being suppressed.

No new photographic or image-generation assets were needed for these catalogue controls. Existing AI editorial stand-ins, pending real business photographs/domain, voice and assumptions remain listed in [the redesign report](../ui-redesign/verification.md). The previous home-page performance budget remains open; this task does not claim to close it.

Functional, pricing, migration and preview evidence: [service delivery](../service-substitution.md).
