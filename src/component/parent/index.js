
import postRobot from 'post-robot/src';
import { SyncPromise as Promise } from 'sync-browser-mocks/src/promise';
import { BaseComponent } from '../base';
import { buildChildWindowName } from '../window';
import { urlEncode, noop, extend, getElement, getParentWindow, once, onCloseWindow, addEventListener, getParentNode, denodeify, memoize, createElement, createStyleSheet, uniqueID, stringifyWithFunctions, capitalizeFirstLetter } from '../../lib';
import { POST_MESSAGE, CONTEXT_TYPES, MAX_Z_INDEX } from '../../constants';
import { RENDER_DRIVERS } from './drivers';
import { validate, validateProps } from './validate';

let activeComponents = [];

/*  Parent Component
    ----------------

    This manages the state of the component on the parent window side - i.e. the window the component is being rendered into.

    It handles opening the necessary windows/iframes, launching the component's url, and listening for messages back from the component.
*/

export class ParentComponent extends BaseComponent {

    constructor(component, options = {}) {
        super(component, options);
        this.component = component;

        validate(component, options);
        this.generateRenderMethods();

        this.id = uniqueID();

        // Ensure the component is not loaded twice on the same page, if it is a singleton

        if (component.singleton && activeComponents.some(comp => comp.component === component)) {
            throw new Error(`${component.tag} is a singleton, and an only be instantiated once`);
        }

        activeComponents.push(this);

        this.registerForCleanup(() => {
            activeComponents.splice(activeComponents.indexOf(this), 1);
        });

        this.parentWindow = getParentWindow();

        this.setProps(options.props || {});


        // Options passed during renderToParent. We would not ordinarily expect a user to pass these, since we depend on
        // them only when we're trying to render from a sibling to a sibling

        this.childWindowName = options.childWindowName || buildChildWindowName({
            parent: window.name,
            id: this.id,
            tag: this.component.tag
        });

        this.screenWidth = options.screenWidth || window.outerWidth;
        this.screenHeight = options.screenHeight || window.outerHeight;


        // Add parent.css to the parent page

        this.createParentStyle();

        // Set up promise for init

        this.onInit = new Promise();
    }


    /*  Set Props
        ---------

        Normalize props and generate the url we'll use to render the component
    */

    setProps(props) {
        validateProps(this.component, props);

        this.props = this.normalizeProps(props);
        this.url   = this.buildUrl();
    }


    /*  Build Url
        ---------

        We build the props we're passed into the initial url. This means the component server-side can start rendering
        itself based on whatever props the merchant provides.
    */

    buildUrl() {

        let url;

        if (this.props.url) {
            url = this.props.url;
        } else if (this.props.env) {
            url = this.component.envUrls[this.props.env];
        } else {
            url = this.component.url;
        }

        let queryString = this.propsToQuery(this.props);

        if (queryString) {
            url = `${ url }${ url.indexOf('?') === -1 ? '?' : '&' }${ queryString }`;
        }

        return url;
    }


    /*  Update Props
        ------------

        Send new props down to the child
    */

    updateProps(props) {
        validateProps(this.component, props);

        // Wait for init to complete successfully

        return this.onInit.then(() => {

            let oldProps = stringifyWithFunctions(this.props);

            let newProps = {};
            extend(newProps, this.props);
            extend(newProps, props);

            this.setProps(newProps);

            // Only send down the new props if they do not match the old

            if (this.window && oldProps !== stringifyWithFunctions(this.props)) {
                return postRobot.send(this.window, POST_MESSAGE.PROPS, {
                    props: this.props
                });
            }
        });
    }


    /*  Normalize Props
        ---------------

        Turn props into normalized values, using defaults, function options, etc.
    */

    normalizeProps(props) {

        props = props || {};
        let result = {};

        for (let key of Object.keys(this.component.props)) {
            result[key] = this.normalizeProp(props, key);
        }

        return result;
    }


     /*  Normalize Props
         ---------------

         Turn prop into normalized value, using defaults, function options, etc.
     */

    normalizeProp(props, key) {

        let prop = this.component.props[key];
        let value = props[key];

        let hasProp = props.hasOwnProperty(key) && value !== null && value !== undefined && value !== '';

        // Substitute in provided default. If prop.def is a function, we call it to get the default.

        if (!hasProp && prop.def) {
            value = (prop.def instanceof Function && prop.type !== 'function') ? prop.def() : prop.def;
        }

        if (prop.type === 'boolean') {
            return Boolean(value);

        } else if (prop.type === 'function') {

            if (!value) {

                // If prop.noop is set, make the function a noop

                if (!value && prop.noop) {
                    value = noop;
                }

            } else {

                // If prop.denodeify is set, denodeify the function (accepts callback -> returns promise)

                if (prop.denodeify) {
                    value = denodeify(value);
                }

                // If prop.once is set, ensure the function can only be called once

                if (prop.once) {
                    value = once(value);
                }

                // If prop.memoize is set, ensure the function is memoized (first return value is cached and returned for any future calls)

                if (prop.memoize) {
                    value = memoize(value);
                }

                value = value.bind(this);
            }

            return value;

        } else if (prop.type === 'string') {
            return value || '';

        } else if (prop.type === 'object') {
            return value;

        } else if (prop.type === 'number') {
            return parseInt(value || 0, 10);
        }
    }


    /*  Props to Query
        --------------

        Turn props into an initial query string to open the component with

        string -> string
        bool   -> 1
        object -> json
        number -> string
    */

    propsToQuery(props) {

        return Object.keys(props).map(key => {

            let value = props[key];

            if (!value) {
                return '';
            }

            let result;

            if (typeof value === 'boolean') {
                result = '1';
            } else if (typeof value === 'string') {
                result = value.toString();
            } else if (typeof value === 'function') {
                return;
            } else if (typeof value === 'object') {
                result = JSON.stringify(value);
            } else if (typeof value === 'number') {
                result = value.toString();
            }

            return `${urlEncode(key)}=${urlEncode(result)}`;

        }).filter(Boolean).join('&');
    }


    /*  Get Position
        ------------

        Calculate the position for the popup / lightbox

        This is either
        - Specified by the user
        - The center of the screen

        I'd love to do this with pure css, but alas... popup windows :(
    */

    getPosition() {

        let pos = {};
        let dimensions = this.component.dimensions;

        if (typeof dimensions.x === 'number') {
            pos.x = dimensions.x;
        } else {
            let width = this.screenWidth;

            if (width <= dimensions.width) {
                pos.x = 0;
            } else {
                pos.x = Math.floor((width / 2) - (dimensions.width / 2));
            }
        }

        if (typeof dimensions.y === 'number') {
            pos.y = dimensions.y;
        } else {

            let height = this.screenHeight;

            if (height <= dimensions.height) {
                pos.y = 0;
            } else {
                pos.y = Math.floor((height / 2) - (dimensions.height / 2));
            }
        }

        return pos;
    }


    /*  Get Render Context
        ------------------

        Determine the ideal context to render to, if unspecified by the user
    */

    getRenderContext(el) {

        if (el) {

            if (!this.component.contexts[CONTEXT_TYPES.IFRAME]) {
                throw new Error(`[${this.component.tag}] Iframe context not allowed`);
            }

            return CONTEXT_TYPES.IFRAME;
        }

        if (this.component.defaultContext) {

            if (this.component.defaultContext === CONTEXT_TYPES.LIGHTBOX) {
                return CONTEXT_TYPES.LIGHTBOX;
            }

            if (this.component.defaultContext === CONTEXT_TYPES.POPUP) {
                return CONTEXT_TYPES.POPUP;
            }
        }

        if (this.component.contexts[CONTEXT_TYPES.LIGHTBOX]) {
            return CONTEXT_TYPES.LIGHTBOX;

        }

        if (this.component.contexts[CONTEXT_TYPES.POPUP]) {
            return CONTEXT_TYPES.POPUP;
        }

        throw new Error(`[${this.component.tag}] No context options available for render`);
    }


    /*  Validate Render
        ---------------

        Ensure there is no reason we can't render
    */

    validateRender(context) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Can not render: component is already rendered`);
        }

        if (context && !this.component.contexts[context]) {
            throw new Error(`Invalid context: ${context}`);
        }
    }


    /*  Render
        ------

        Kick off the actual rendering of the component:

        - open the popup/iframe
        - load the url into it
        - set up listeners
    */

    render(element, context) {

        this.validateRender(context);

        context = context || this.getRenderContext(element);

        if (RENDER_DRIVERS[context].render) {
            RENDER_DRIVERS[context].render.call(this, element);
        }

        this.setForCleanup('context', context);

        this.open(element, context);
        this.listen(this.window);
        this.loadUrl(this.url);
        this.runTimeout();

        if (RENDER_DRIVERS[context].overlay) {
            this.createOverlayTemplate();
        }

        this.watchForClose();

        return this;
    }


    /*  Open
        ----

        Open a new window in the desired context
    */

    open(element, context) {

        RENDER_DRIVERS[context].open.call(this, element);

        this.watchForClose();

        this.createComponentTemplate();
    }


    /*  Render to Parent
        ----------------

        Instruct the parent window to render our component for us -- so, for example, we can have a button component
        which opens a lightbox on the parent page, with a full overlay. Or, we could use this to render an iframe based
        modal on top of our existing iframe component, without having to expand out the size of our current iframe.
    */

    renderToParent(element, context, options = {}) {

        this.validateRender(context);

        context = context || this.getRenderContext(element);

        if (!this.parentWindow) {
            throw new Error(`[${this.component.tag}] Can not render to parent - no parent exists`);
        }

        if (!window.name) {
            throw new Error(`[${this.component.tag}] Can not render to parent - not in a child component window`);
        }

        // Set a new childWindowName to let it know it's going to be a sibling, not a direct child

        this.childWindowName = buildChildWindowName({
            id: this.id,
            parent: window.name,
            sibling: true,
            tag: this.component.tag
        });

        this.setForCleanup('context', context);

        // Do any specific stuff needed for particular contexts. For example -- for popups, we have no choice but to
        // open them from the child, since we depend on there being a click event to avoid the popup blocker.

        if (RENDER_DRIVERS[context].renderToParent) {
            RENDER_DRIVERS[context].renderToParent.call(this, element);
        }

        // Message the parent to instruct them on what to render and how. Since post-robot supports sending functions
        // across, we can pretty much just send all of our props over too without any problems

        return postRobot.sendToParent(POST_MESSAGE.RENDER, {

            // <3 ES6
            ...options,

            tag: this.component.tag,
            context,
            element,

            options: {
                props: this.props,

                childWindowName: this.childWindowName,
                screenWidth:     this.screenWidth,
                screenHeight:    this.screenHeight
            }

        }).then(data => {

            // Luckily we're allowed to access any frames created by our parent window, so we can get a handle on the child component window.

            if (!this.window) {
                this.setForCleanup('window', this.parentWindow.frames[this.childWindowName]);
            }

            // We don't want to proxy all of our messages through the parent window. Instead we'll just listen directly for
            // messages on the sibling window, since we have a handle on it.

            this.listen(this.window);

            this.watchForClose();

            return this;
        });
    }


    /*  Generate Render Methods
        -----------------------

        Autogenerate methods like renderIframe, renderPopupToParent, hijackButtonToLightbox
    */

    generateRenderMethods() {

        [ CONTEXT_TYPES.IFRAME, CONTEXT_TYPES.LIGHTBOX, CONTEXT_TYPES.POPUP ].forEach(context => {

            let contextName = capitalizeFirstLetter(context);

            this[`render${contextName}`] = function(element) {
                return this.render(element, context);
            };

            this[`render${contextName}ToParent`] = function(element) {
                return this.renderToParent(element, context);
            };

            this[`hijackButtonTo${contextName}`] = function(element) {
                return this.hijackButton(element, context);
            };
        });
    }

    /*  Watch For Close
        ---------------

        Watch for the child window closing, so we can cleanup.
        Also watch for this window changing location, so we can close the component.
    */

    watchForClose() {

        let closeWindowListener = onCloseWindow(this.window, () => {
            this.props.onClose();
            this.destroy();
        });

        // Our child has know way of knowing if we navigated off the page. So we have to listen for beforeunload
        // and close the child manually if that happens.

        let unloadListener = addEventListener(window, 'beforeunload', () => {
            if (this.context === CONTEXT_TYPES.POPUP) {
                this.window.close();
            }
        });

        this.registerForCleanup(() => {
            closeWindowListener.cancel();
            unloadListener.cancel();
        });
    }


    /*  Load Url
        --------

        Load url into the child window. This is separated out because it's quite common for us to have situations
        where opening the child window and loading the url happen at different points.
    */

    loadUrl(url) {
        return RENDER_DRIVERS[this.context].loadUrl.call(this, url);
    }


    /*  Hijack Button
        -------------

        In this case, we don't actually know the final url for the component. The parent page might have a link or a form
        which points directly to our component url, or indirectly via a 302.

        So here, we listen for a click on the button or link, and hijack the target window. That way, we can be responsible
        for opening the window, listening for messages, etc. while the parent page is responsible only for generating the url
        to redirect to.

        This is necessary because in these cases, there's no way to accurately ascertain the url we're going to before
        we're redirected there -- so we let the parent redirect, but handle everything else involving the lifecycle of
        the component.

        This is a pretty esoteric case -- so if you need it, cool, otherwise you don't need to spend too much time
        worrying about it.
    */

    hijackButton(element, context = CONTEXT_TYPES.LIGHTBOX) {
        let el = getElement(element);

        if (!el) {
            throw new Error(`[${this.component.tag}] Can not find element: ${element}`);
        }

        let isButton = el.tagName.toLowerCase() === 'button' || (el.tagName.toLowerCase() === 'input' && el.type === 'submit');

        // For links, we can set the target directly on the link. But for form buttons, we need to set the target on the form itself.

        let targetElement = isButton ? getParentNode(el, 'form') : el;

        // We need to wait for the click event, which is necessary for opening a popup (if we need to)

        el.addEventListener('click', event => {

            if (this.window) {
                event.preventDefault();
                throw new Error(`[${this.component.tag}] Component is already rendered`);
            }

            // Open the window to render into

            this.renderHijack(targetElement, context);
        });

        return this;
    }


    /*  Render Hijack
        -------------

        Do a normal render, with the exception that we don't load the url into the child since our hijacked link or button will do that for us
    */

    renderHijack(el, context = CONTEXT_TYPES.LIGHTBOX) {

        this.validateRender(context);

        this.setForCleanup('context', context);

        // Point the element to open in our child window

        el.target = this.childWindowName;

        // Immediately open the window, but don't try to set the url -- this will be done by the browser using the form action or link href

        this.open(null, context);

        // Do everything else the same way -- listen for events, render the overlay, etc.

        this.listen(this.window);
        this.runTimeout();

        if (RENDER_DRIVERS[context].overlay) {
            this.createOverlayTemplate();
        }
    }


    /*  Hijack Submit Parent Form
        -------------------------

        This takes the 'hijack' case a little further, and allows hijacking to work even when the button is actually
        in a child component. So if the parent window has a form, and inside that form is a component, and inside that
        component is a button, this can be used to submit the parent form using the child button and hijack the resulting
        url into an xcomponent.

        This is, again, an esoteric case within an esoteric case -- so probably only consider using it if you're sure you want to.
    */

    hijackSubmitParentForm() {
        return this.renderToParent(null, CONTEXT_TYPES.POPUP, {
            hijackSubmitParentForm: true
        });
    }


    /*  Run Timeout
        -----------

        Set a timeout on the initial render, and call this.props.onTimeout if we don't get an init call in time.
    */

    runTimeout() {

        if (this.props.timeout) {
            setTimeout(() => {

                // If this.onInit has been previously resolved, this won't have any effect.

                let error = new Error(`[${this.component.tag}] Loading component ${this.component.tag} at ${this.url} timed out after ${this.props.timeout} milliseconds`);

                this.onInit.reject(error).catch(err => {
                    this.props.onTimeout(err);
                    this.destroy();
                });

            }, this.props.timeout);
        }
    }


    /*  Listeners
        ---------

        Post-robot listeners to the child component window
    */

    listeners() {
        return {

            // The child rendered, and the component called .attach()
            // We have no way to know when the child has set up its listeners for the first time, so we have to listen
            // for this message to be sure so we can continue doing anything from the parent

            [ POST_MESSAGE.INIT ](source, data) {
                this.props.onEnter();
                this.onInit.resolve();

                // Let the child know what its context is, and what its initial props are.

                return {
                    context: this.context,
                    props: this.props
                };
            },


            // The child has requested that we close it. Since lightboxes and iframes can't close themselves, we need
            // this logic to exist in the parent window

            [ POST_MESSAGE.CLOSE ](source, data) {

                this.close();
            },

            // We got a request to render from the child (renderToParent)

            [ POST_MESSAGE.RENDER ](source, data) {

                let component = this.component.getByTag(data.tag);
                let instance  = component.parent(data.options);

                // In the case where we're submitting the parent form using hijackSubmitParentForm

                if (data.hijackSubmitParentForm) {

                    let form = getParentNode(this.iframe, 'form');

                    // Open the window and do everything except load the url

                    instance.renderHijack(form, data.context);

                    // Submit the form to load the url into the new window

                    form.submit();
                }

                // Otherwise we're just doing a normal render on behalf of the child

                else {
                    instance.render(data.element, data.context);
                }
            },


            // The child encountered an error

            [ POST_MESSAGE.ERROR ](source, data) {
                this.error(new Error(data.error));
            }
        };
    }


    /*  Close
        -----

        Close the child component
    */

    close() {

        // We send a post message to the child to close. This has two effects:
        // 1. We let the child do any cleanup it needs to do
        // 2. We let the child message its actual parent to close it, which we can't do here if it's a renderToParent

        this.props.onClose();

        return postRobot.send(this.window, POST_MESSAGE.CLOSE).catch(err => {

            // If we get an error, log it as a warning, but don't error out

            console.warn(`Error sending message to child`, err.stack || err.toString());

        }).then(() => {

            // Whatever happens, we'll destroy the child window

            this.destroy();
        });
    }


    /*  Focus
        -----

        Focus the child component window
    */

    focus() {
        if (this.window) {
            this.window.focus();
        }
        return this;
    }


    /*  Create Parent Style
        -------------------

        Creates a stylesheet on the parent page, to control how the child component is rendered
    */

    createParentStyle() {
        this.overlayStyle = createStyleSheet(this.component.parentStyle, document.body);
    }


    /*  Create Component Template
        -------------------------

        Creates an initial template and stylesheet which are loaded into the child window, to be displayed before the url is loaded
    */

    createComponentTemplate() {

        createElement('body', {

            html: this.component.componentTemplate,

            class: [
                'xcomponent-component'
            ]

        }, this.window.document.body);

        createStyleSheet(this.component.componentStyle, this.window.document.body);
    }


    /*  Create Overlay Template
        -----------------------

        Create a template and stylesheet for the overlay behind the popup/lightbox
    */

    createOverlayTemplate() {

        this.overlay = createElement('div', {

            html: this.component.overlayTemplate,

            class: [
                `xcomponent-overlay`,
                `xcomponent-${this.context}`
            ],

            style: {
                zIndex: MAX_Z_INDEX - 1
            }

        }, document.body);

        this.overlayStyle = createStyleSheet(this.component.overlayStyle, document.body);

        this.overlay.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this.focus();
        });

        Array.prototype.slice.call(this.overlay.getElementsByClassName('xcomponent-close')).forEach(el => {
            el.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            });
        });

        this.registerForCleanup(() => {
            document.body.removeChild(this.overlay);
            document.body.removeChild(this.overlayStyle);
        });
    }


    /*  Destroy
        -------

        Close the component and clean up any listeners and state
    */

    destroy() {
        this.cleanup();
    }


    /*  Error
        -----

        Handle an error
    */

    error(err) {
        this.props.onError(err);
        this.destroy();
    }
}