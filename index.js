const fs = require('fs');
const url = require('url');
const axios = require('axios');
const cheerio = require('cheerio');
const sizeOf = require('image-size');
const CleanCss = require('clean-css');
const urlencode = require('urlencode');

const imageUrlRegex = /(.*\/)(.+\..+)/;
const utf8Regex = /[^\u0000-\u007f]/;

module.exports = async (html, options) => {
    const tags = {
        amp: ['img', 'video'],
    };

    let youtube = false;

    const cheerioOptions = options || {
        cwd: options.cwd || '',
        round: options.round || true,
        normalizeWhitespace: options.normalizeWhitespace || false,
        xmlMode: options.xmlMode || false,
        decodeEntities: options.decodeEntities || false,
    };

    const $ = cheerio.load(html, cheerioOptions);

    const round = cheerioOptions.round ? numb => Math.round(numb / 5) * 5 : numb => numb;

    /* Fetch images and CSS */
    const promises = [];
    const responses = {};

    $('img:not([width]):not([height])').each((index, element) => {
        const src = $(element).attr('src');
        // skip if already fetched
        if (responses[src]) {
            return;
        }
        if (src && src.indexOf('//') !== -1) {
            // set a flag
            responses[src] = true;
            const imageUrl = element.attribs.src;
            if (utf8Regex.test(imageUrl)) {
                const matchedStr = imageUrlRegex.exec(imageUrl);
                const encodedImageUrl = matchedStr[1] + urlencode(matchedStr[2]);
                promises.push(axios.get(encodedImageUrl, {responseType: 'arraybuffer'})
                    .then((response) => {
                        responses[src] = response;
                    }).catch(error => {
                        if (error?.response?.status === 404) {
                            responses[src] = false;
                            console.error("[404] Ampify src (" + src + ")");
                        }
                    }));
                return;
            }
            promises.push(axios.get(imageUrl, {responseType: 'arraybuffer'})
                .then((response) => {
                    responses[src] = response;
                }).catch(error => {
                    if (error?.response?.status === 404) {
                        responses[src] = false;
                        console.error("[404] Ampify src (" + src + ")");
                    }
                }));
        }
    });

    $('link[rel=stylesheet]').each((index, element) => {
        const src = $(element).attr('href');
        if (responses[src]) {
            return;
        }
        try {
            if (src && src.indexOf('//') !== -1) {
                let cssSrc = src;
                if (src.indexOf('//') === 0) {
                    cssSrc = `https:${src}`;
                }
                responses[src] = true;
                promises.push(axios.get(cssSrc)
                    .then((response) => {
                        responses[src] = response;
                    }));
            }
        } catch (err) {
            console.dir(err);
        }
    });

    await Promise.all(promises);

    /* html ⚡ */
    $('html').each((index, element) => {
        $(element).attr('amp', '');
    });

    $('*').removeAttr("nowrap");
    $('*').removeAttr("style");
    $('*').removeAttr("clear");
    $('*').removeAttr("frame");
    $('*').removeAttr("rules");
    $('*').removeAttr("scope");
    $('*').removeAttr("width");
    $('*').removeAttr("border");
    $('*').removeAttr("loading");
    $('*').removeAttr("contenteditable");
    $('*').removeAttr("match");
    $('*').removeAttr("loopnumber");
    $('*').removeAttr("e");
    $('*').find('script').remove();

    /* google analytics */
    $('script').each((index, element) => {
        const src = $(element).attr('src');
        if (src) {
            const trackingId = src.match(/\bUA-\d{4,10}-\d{1,4}\b/);
            if (trackingId) {
                $(element).remove();
                $('head').prepend('<script async custom-element="amp-analytics"src="https://cdn.ampproject.org/v0/amp-analytics-0.1.js"></script>');
                $('body').append(`<amp-analytics type="googleanalytics">
          <script type="application/json">
            { "vars": {
                "account": "${trackingId}"
              },
              "triggers": {
                "trackPageview": {
                  "on": "visible",
                  "request": "pageview"
                }
              }
            }
          </script>
        </amp-analytics>`);
            }
        }
        const scriptContent = $(element).html();
        const htmlScriptContent = scriptContent.match(/function gtag\(\){dataLayer\.push\(arguments\);}/);
        if (scriptContent && htmlScriptContent) {
            $(element).remove();
        }
    });

    /* body */

    /* img dimensions */
    $('img:not([width]):not([height])').each((index, element) => {
        const src = $(element).attr('src');
        if (!src) {
            return $(element).remove();
        }
        if (src.indexOf('//') === -1) {
            const image = `${options.cwd}/${$(element).attr('src')}`;
            if (fs.existsSync(image)) {
                const size = sizeOf(image);
                $(element).attr({
                    width: round(size.width),
                    height: round(size.height),
                    layout: (options && options.layout) || "responsive",
                });
            }
        } else if (src.indexOf('//') !== -1) {
            const response = responses[src];
            if (response === false) {
                if (options.ignoreImageNotFound) {
                    return $(element).remove();
                }
            }
            if (response === true) {
                throw new Error('No image for', src);
            }
            const size = sizeOf(Buffer.from(response.data, 'binary'));
            $(element).attr({
                width: round(size.width),
                height: round(size.height),
                layout: (options && options.layout) || "responsive",
            });
        }
    });

    /* inline styles */
    $('link[rel=stylesheet]').each((index, element) => {
        const src = $(element).attr('href');
        let path = src;
        let file = '';
        const setFile = (data) => {
            const minified = new CleanCss().minify(data).styles;
            return `<style amp-custom>${minified}</style>`;
        };

        try {
            if (src.indexOf('//') === -1) {
                path = `${options.cwd}/${src}`;
                if (fs.existsSync(path)) {
                    file = setFile(String(fs.readFileSync(path)));
                }
            } else if (src.indexOf('//') !== -1) {
                const response = responses[src];
                if (response === true) {
                    throw new Error('No CSS for', src);
                }
                file = setFile(response.data);
            }
        } catch (err) {
            console.dir(err);
        }
        $(element).replaceWith(file);
    });

    /* youtube */
    $('iframe[src*="http://www.youtube.com"],iframe[src*="https://www.youtube.com"],iframe[src*="http://youtu.be/"],iframe[src*="https://youtu.be/"]').each((index, element) => {
        youtube = true;
        const src = $(element).attr('src');
        const width = $(element).attr('width');
        const height = $(element).attr('height');
        const path = url.parse(src).pathname.split('/');
        const ampYoutube = `
    <amp-youtube
      data-videoid="${path[path.length - 1]}"
      width="${width}"
      height="${height}"
      layout="responsive">
    </amp-youtube>`;
        $(element).replaceWith(ampYoutube);
    });

    if (youtube) {
        $('head').prepend('<script async custom-element="amp-youtube" src="https://cdn.ampproject.org/v0/amp-youtube-0.1.js">');
    }

    $("audio").each((index, element) => {
        const ampElement = Object.assign(element, {
            name: `amp-audio`,
        });
        $(element).attr("width","300");
        $(element).attr("height","59");
        $(element).html($(ampElement).html());
    });

    /* amp tags */
    $(tags.amp.join(',')).each((index, element) => {
        const ampElement = Object.assign(element, {
            name: `amp-${element.name}`,
        });
        $(element).html($(ampElement).html());
    });

    return $.html();
};
