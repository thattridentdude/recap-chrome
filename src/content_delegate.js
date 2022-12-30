//  Abstraction of content scripts to make them modular and testable.
//  Functions:
//  checkRestrictions
//  findAndStorePacerIds
//  handleDocketQueryUrl
//  handleDocketDisplayPage
//  handleAttachmentPageMenu
//  handleSingleDocumentPageCheck
//  handleOnDocumentViewSubmit
//  showPdfPage
//  handleSingleDocumentPageView
//  handleRecapLinkClick
//  attachRecapLinkToEligibleDocs
//  onDownloadAllSubmit
//  handleZipFilePageView

let ContentDelegate = function (tabId, url, path, court, pacer_case_id, pacer_doc_id, links) {
  this.tabId = tabId;
  this.url = url;
  this.path = path;
  this.court = court;
  this.pacer_case_id = pacer_case_id;
  if (pacer_doc_id) {
    this.pacer_doc_id = pacer_doc_id;
    this.pacer_doc_ids = [pacer_doc_id];
  } else {
    this.pacer_doc_ids = [];
  }
  this.links = links || [];

  this.notifier = importInstance(Notifier);
  this.recap = importInstance(Recap);

  this.restricted = this.checkRestrictions();
};

// Check for document restrictions
ContentDelegate.prototype.checkRestrictions = function () {
  // Some documents are restricted to case participants. Typically
  // this is offered with either an interstitial page (in the case
  // of free looks) or an extra box on the receipt page. In both cases
  // it's something like this:
  //
  // <table><tbody>
  //   <tr><td>Warning!</td></tr>
  //   <tr><td><b>This document is restricted to court users,
  //              case participants and public terminal users.</b></td></tr>
  // </tbody></table>
  //
  // The exact text will change, depending on the circumstances. For
  // sealed documents, e.g., ohsd offers:
  //
  //   "The document you are about to view is SEALED; do not allow it
  //   to be seen by unauthorized persons."
  //
  // Sealing behavior differs from CMECF instance to CMECF instance.
  //
  // Be somewhat paranoid about this and check for either a "Warning!"
  // in the first <td> cell of a table, as well as any <b> containing
  // "document is restricted", "SEALED", or "do not allow it to be seen".
  // Case-insensitively.

  // The regexes below are pretty broad by design.
  // Only trigger this code on doc1 pages.
  if (!PACER.isSingleDocumentPage(this.url, document)) {
    return false;
  }

  let restrictedDoc = false;

  for (let td of document.querySelectorAll('table td:first-child')) {
    if (td.textContent.match(/Warning!/)) {
      restrictedDoc = true;
      break;
    }
  }

  for (let td of document.querySelectorAll('b')) {
    if (td.textContent.match(/document is restricted|SEALED|do not allow it to be seen/i)) {
      restrictedDoc = true;
      break;
    }
  }

  if (restrictedDoc) {
    console.log('RECAP: Restricted document detected. Skipping upload.');
    // We would like to alter the [R] icon to indicate what's going
    // on, but we cannot call chrome.browserAction.setIcon()
    // here. Instead, we'd need to send a message to the background
    // script? ughhhh. Punt for now.

    // Insert a RECAP banner near the end of the form, before the action button.
    // Ideally this would have some RECAP branding, icon/logo, etc.

    // Ideally we target the form <input>, but absent that
    // we just go to the end of the final form.
    // Should we just always go the end of the final form?
    let target = document.querySelector('form input') || document.forms[document.forms.length - 1].lastChild;

    // Nested div for horizontal centering.
    target.insertAdjacentHTML(
      'beforebegin',
      `<div style="text-align: center">
              <div style="display: inline-block; text-align: left; align: top">
                <div class="recap-banner" style="display: table">
                  <div style="display: table-cell; padding: 12px; ">
                    <img src="${chrome.extension.getURL('assets/images/disabled-38.png')}"
                         style="width: auto; height: auto">
                  </div>
                  <div style="display: table-cell; vertical-align: middle">This document <b>will not be uploaded</b> to the RECAP Archive because the RECAP extension has detected that it may be restricted from public distribution.
                  </div>
                </div>
              </div>
            </div>`
    );
  }

  return restrictedDoc;
};

// Use a variety of approaches to get and store pacer_doc_id to pacer_case_id
// mappings in local storage.
ContentDelegate.prototype.findAndStorePacerDocIds = async function () {
  if (!PACER.hasPacerCookie(document.cookie)) {
    return;
  }

  // Not all pages have a case ID, and there are corner-cases in merged dockets
  // where there are links to documents on another case.
  let page_pacer_case_id = this.pacer_case_id
    ? this.pacer_case_id
    : await getPacerCaseIdFromPacerDocId(this.tabId, this.pacer_doc_id);

  let docsToCases = {};

  // Try getting a mapping from a pacer_doc_id in the URL to a
  if (this.pacer_doc_id && page_pacer_case_id && typeof page_pacer_case_id === 'string') {
    debug(3, `Z doc ${this.pacer_doc_id} to ${page_pacer_case_id}`);
    docsToCases[this.pacer_doc_id] = page_pacer_case_id;
  }

  for (let i = 0; i < this.links.length; i++) {
    let link = this.links[i];
    if (PACER.isDocumentUrl(link.href)) {
      let pacer_doc_id = PACER.getDocumentIdFromUrl(link.href);
      $(link).data('pacer_doc_id', pacer_doc_id);
      this.pacer_doc_ids.push(pacer_doc_id);

      let onclick = link.getAttribute('onclick');
      let goDLS = PACER.parseGoDLSFunction(onclick);

      if (goDLS && goDLS.de_caseid) {
        docsToCases[pacer_doc_id] = goDLS.de_caseid;
        debug(3, `Y doc ${pacer_doc_id} to ${goDLS.de_caseid}`);
      } else if (page_pacer_case_id) {
        docsToCases[pacer_doc_id] = page_pacer_case_id;
        debug(3, `X doc ${pacer_doc_id} to ${page_pacer_case_id}`);
      }
    }
  }
  // save JSON object in chrome storage under the tabId
  // append caseId if a docketQueryUrl
  const payload = {
    docsToCases: docsToCases,
  };
  if (!!this.pacer_doc_id) {
    payload['docId'] = this.pacer_doc_id;
  }
  if (PACER.isDocketQueryUrl(this.url) && page_pacer_case_id) {
    payload['caseId'] = page_pacer_case_id;
  }

  updateTabStorage({
    [this.tabId]: payload,
  });
};

// If this is a docket query page, add RECAP email advertisement.
ContentDelegate.prototype.addRecapEmailAdvertisement = async function () {
  if (!(PACER.isBlankQueryReportUrl(this.url) || PACER.isManageAccountPage(this.url))) {
    return;
  }
  let form;

  if (!PACER.hasFilingCookie(document.cookie)) {
    return;
  }

  if (PACER.isBlankQueryReportUrl(this.url)) {
    form = document.querySelector('form');
    if (!document.querySelector('.recap-email-banner')) {
      form.appendChild(recapEmailBanner());
    }
  } else {
    form = document.querySelector('#popupForm');
    if (!document.querySelector('.recap-email-banner-full')) {
      form.after(recapEmailBanner('recap-email-banner-full'));
    }
  }
};

// If this is a docket query page, ask RECAP whether it has the docket page.
ContentDelegate.prototype.handleDocketQueryUrl = function () {
  if (!PACER.isDocketQueryUrl(this.url)) {
    return;
  }
  // Logged out users that load a docket page, see a login page, so they
  // shouldn't check for docket availability.
  if (!PACER.hasPacerCookie(document.cookie)) {
    return;
  }

  this.recap.getAvailabilityForDocket(this.court, this.pacer_case_id, null, (result) => {
    if (result.count === 0) {
      console.warn('RECAP: Zero results found for docket lookup.');
    } else if (result.count > 1) {
      console.error(`RECAP: More than one result found for docket lookup. Found ${result.count}`);
    } else {
      if (result.results) {
        PACER.removeBanners();
        const form = document.querySelector('form');
        const div = document.createElement('div');
        div.classList.add('recap-banner');
        div.appendChild(recapAlertButton(this.court, this.pacer_case_id, true));
        form.appendChild(recapBanner(result.results[0]));
        form.appendChild(div);
      }
    }
  });
};

// If this is a docket page, upload it to RECAP.
ContentDelegate.prototype.handleDocketDisplayPage = async function () {
  // helper functions
  const createActionButtonTr = () => {
    const tr = document.createElement('tr');
    tr.appendChild(recapActionsButton(this.court, this.pacer_case_id, false));
    return tr;
  };

  // If it's not a docket display URL or a docket history URL, punt.
  let isDocketDisplayUrl = PACER.isDocketDisplayUrl(this.url);
  let isDocketHistoryDisplayUrl = PACER.isDocketHistoryDisplayUrl(this.url);
  if (!(isDocketHistoryDisplayUrl || isDocketDisplayUrl)) {
    return;
  }

  // check for more than one radioDateInput and return if true
  // (you are on an interstitial page so no docket to display)
  const radioDateInputs = [...document.getElementsByTagName('input')].filter(
    (input) => input.name === 'date_from' && input.type === 'radio'
  );
  if (radioDateInputs.length > 1) {
    return;
  }

  // check if appellate
  // let isAppellate = PACER.isAppellateCourt(this.court);

  // if the content_delegate didn't pull the case Id on initialization,
  // check the page for a lead case dktrpt url.
  const tabStorage = await getItemsFromStorage(this.tabId);
  this.pacer_case_id = this.pacer_case_id ? this.pacer_case_id : tabStorage.caseId;

  // If we don't have this.pacer_case_id at this point, punt.
  if (!this.pacer_case_id) {
    return;
  }

  const tableBody = document.querySelector('tbody');
  const existingActionButton = document.getElementById('recap-action-button');
  if (!existingActionButton) {
    const tr = createActionButtonTr();
    tableBody.insertBefore(tr, tableBody.childNodes[0]);
  }

  this.recap.getAvailabilityForDocket(this.court, this.pacer_case_id, null, (result) => {
    if (result.count === 0) {
      console.warn('RECAP: Zero results found for docket lookup.');
    } else if (result.count > 1) {
      console.error(`RECAP: More than one result found for docket lookup. Found ${result.count}`);
    } else {
      addAlertButtonInRecapAction(this.court, this.pacer_case_id);
      let cl_id = getClIdFromAbsoluteURL(result.results[0].absolute_url);
      addSearchDocketInRecapAction(cl_id);
    }
  });

  // if you've already uploaded the page, return
  if (history.state && history.state.uploaded) {
    return;
  }

  const options = await getItemsFromStorage('options');

  if (options['recap_enabled']) {
    let callback = (ok) => {
      if (ok) {
        addAlertButtonInRecapAction(this.court, this.pacer_case_id);
        history.replaceState({ uploaded: true }, '');
        this.notifier.showUpload('Docket uploaded to the public RECAP Archive.', function () {});
      }
    };
    if (isDocketDisplayUrl) {
      this.recap.uploadDocket(this.court, this.pacer_case_id, document.documentElement.innerHTML, 'DOCKET', (ok) =>
        callback(ok)
      );
    } else if (isDocketHistoryDisplayUrl) {
      this.recap.uploadDocket(
        this.court,
        this.pacer_case_id,
        document.documentElement.innerHTML,
        'DOCKET_HISTORY_REPORT',
        (ok) => callback(ok)
      );
    }
  } else {
    console.info(`RECAP: Not uploading docket. RECAP is disabled.`);
  }
};

// If this is a document's menu of attachments (subdocuments), upload it to
// RECAP.
ContentDelegate.prototype.handleAttachmentMenuPage = function () {
  if (history.state && history.state.uploaded) {
    return;
  }

  if (!PACER.isAttachmentMenuPage(this.url, document)) {
    return;
  }

  chrome.storage.local.get(
    'options',
    function (items) {
      if (items['options']['recap_enabled']) {
        let callback = $.proxy(function (ok) {
          if (ok) {
            history.replaceState({ uploaded: true }, '');
            this.notifier.showUpload('Menu page uploaded to the public RECAP Archive.', function () {});
          }
        }, this);

      this.recap.uploadAttachmentMenu(this.court, this.pacer_case_id,
        document.documentElement.innerHTML, 'ATTACHMENT_PAGE', callback);
    } else {
      console.info("RECAP: Not uploading attachment menu. RECAP is disabled.");
    }
  }.bind(this));
};

//if this a iquery page with case information, upload it to RECAP
ContentDelegate.prototype.handleiQuerySummaryPage = async function () {
  // avoid uploading the same page multiple times
  if (history.state && history.state.uploaded) {
    return;
  }

  if (!PACER.isIQuerySummaryURL(this.url)) {
    return;
  }

  if (PACER.isSelectAPersonPage()) {
    // This if statement will end this function early if the user reaches this page.
    return;
  }

  if (!this.pacer_case_id && !PACER.isCaseQueryAdvance()) {
    let caseId = PACER.getCaseIdFromIQuerySummary();
    // End this function early if we're not able to find a case id
    if (!caseId) {
      return;
    }
    this.pacer_case_id = caseId;
  }

  const options = await getItemsFromStorage('options');
  if (options['recap_enabled']) {
    let callback = $.proxy(function (ok) {
      if (ok) {
        history.replaceState({ uploaded: true }, '');
        this.notifier.showUpload('iQuery page uploaded to the public RECAP Archive.', function () {});
      }
    }, this);
    let upload_type = PACER.isCaseQueryAdvance() ? 'CASE_QUERY_RESULT_PAGE' : 'IQUERY_PAGE';
    this.recap.uploadIQueryPage(
      this.court,
      this.pacer_case_id,
      document.documentElement.innerHTML,
      upload_type,
      callback
    );
  } else {
    console.info('RECAP: Not uploading iquery page. RECAP is disabled.');
  }
};

// If this page offers a single document, ask RECAP whether it has the document.
ContentDelegate.prototype.handleSingleDocumentPageCheck = function () {
  if (!PACER.isSingleDocumentPage(this.url, document)) {
    return;
  }

  let callback = $.proxy(function (api_results) {
    console.info(`RECAP: Got results from API. Running callback on API results to ` + `insert link`);
    let result = api_results.results.filter(function (obj) {
      return obj.pacer_doc_id === pacer_doc_id;
    })[0];
    if (!result) {
      return;
    }

    insertAvailableDocBanner(result.filepath_local, 'form');
  }, this);

  let cl_court = PACER.convertToCourtListenerCourt(this.court);
  this.recap.getAvailabilityForDocuments([this.pacer_doc_id], cl_court, callback);
};

ContentDelegate.prototype.onDocumentViewSubmit = function (event) {
  // Security check to ensure message is from a PACER website.
  if (!PACER.getCourtFromUrl(event.origin)) {
    console.warn(
      'Received message from non PACER origin. This should only ' +
        'happen when the extension is being abused by a bad actor.'
    );
    return;
  }

  let previousPageHtml = copyPDFDocumentPage();
  let form = document.getElementById(event.data.id);

  let pdfData = PACER.parseDataFromReceipt();

  if (!pdfData) {
    form.submit();
    return;
  }

  // Now do the form request to get to the view page.  Some PACER sites will
  // return an HTML page containing an <iframe> that loads the PDF document;
  // others just return the PDF document.  As we don't know whether we'll get
  // HTML (text) or PDF (binary), we ask for an ArrayBuffer and convert later.
  $('body').css('cursor', 'wait');
  let data = new FormData(form);
  httpRequest(
    form.action,
    data,
    null,
    function (type, ab, xhr) {
      let requestHandler = handleDocFormResponse.bind(this);
      requestHandler(type, ab, xhr, previousPageHtml, pdfData);
    }.bind(this)
  );
};

// Given the HTML for a page with an <iframe> in it, downloads the PDF
// document in the iframe, displays it in the browser, and also
// uploads the PDF document to RECAP.
//
// The documentElement is provided via dependency injection so that it
// can be properly mocked in tests.
ContentDelegate.prototype.showPdfPage = async function (
  html,
  previousPageHtml,
  document_number,
  attachment_number,
  docket_number
) {
  let helperMethod = showAndUploadPdf.bind(this);
  await helperMethod(
    html,
    previousPageHtml,
    document_number,
    attachment_number,
    docket_number,
    this.pacer_doc_id,
    this.restricted
  );
};

// If this page offers a single document, intercept navigation to the document
// view page.  The "View Document" button calls the goDLS() function, which
// creates a <form> element and calls submit() on it, so we hook into submit().
ContentDelegate.prototype.handleSingleDocumentPageView = function () {
  if (!PACER.isSingleDocumentPage(this.url, document)) {
    return;
  }

  overwriteFormSubmitMethod();

  // When we receive the message from the above submit method, submit the form
  // via XHR so we can get the document before the browser does.
  window.addEventListener('message', this.onDocumentViewSubmit.bind(this), false);
};

// Check every link in the document to see if there is a free RECAP document
// available. If there is, put a link with a RECAP icon.
ContentDelegate.prototype.attachRecapLinkToEligibleDocs = function () {
  let linkCount = this.pacer_doc_ids.length;
  console.info(`RECAP: Attaching links to all eligible documents (${linkCount} found)`);
  if (linkCount === 0) {
    return;
  }

  // Ask the server whether any of these documents are available from RECAP.
  this.recap.getAvailabilityForDocuments(
    this.pacer_doc_ids,
    this.court,
    $.proxy(function (api_results) {
      console.info(
        `RECAP: Got results from API. Running callback on API results to ` + `attach links and icons where appropriate.`
      );
      for (let i = 0; i < this.links.length; i++) {
        let pacer_doc_id = $(this.links[i]).data('pacer_doc_id');
        if (!pacer_doc_id) {
          continue;
        }
        let result = api_results.results.filter(function (obj) {
          return obj.pacer_doc_id === pacer_doc_id;
        })[0];
        if (!result) {
          continue;
        }
        let href = `https://storage.courtlistener.com/${result.filepath_local}`;
        let recap_link = $('<a/>', {
          class: 'recap-inline',
          title: 'Available for free from the RECAP Archive.',
          href: href,
        });
        recap_link.append(
          $('<img/>').attr({
            src: chrome.extension.getURL('assets/images/icon-16.png'),
          })
        );
        recap_link.insertAfter(this.links[i]);
      }
      let spinner = document.getElementById('recap-button-spinner');
      if (spinner) {
        spinner.classList.add('recap-btn-spinner-hidden');
      }
    }, this)
  );
};

// TODO: Confirm that zip downloading is consistent across jurisdictions
ContentDelegate.prototype.onDownloadAllSubmit = async function (event) {
  // helper function - extract the zip by creating html and querying the frame
  const extractUrl = (html) => {
    const page = document.createElement('html');
    page.innerHTML = html;
    const frames = page.querySelectorAll('iframe');
    return frames[0].src;
  };

  // helper function - convert string to html document
  const stringToDocBody = (str) => {
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(str, 'text/html');
    return newDoc.body;
  };

  // helper function - returns filename based on user preferences
  const generateFileName = (options, pacerCaseId) => {
    if (options.ia_style_filenames) {
      return ['gov', 'uscourts', this.court, pacerCaseId || 'unknown-case-id'].join('.').concat('.zip');
    } else if (options.lawyer_style_filenames) {
      const firstTable = document.getElementsByTagName('table')[0];
      const firstTableRows = firstTable.querySelectorAll('tr');
      // 4th from bottom
      const matchedRow = firstTableRows[firstTableRows.length - 4];
      const cells = matchedRow.querySelectorAll('td');
      const document_number = cells[0].innerText.match(/\d+(?=\-)/)[0];
      const docket_number = cells[1].innerText;
      return [PACER.COURT_ABBREVS[this.court], docket_number, document_number].join('_').concat('.zip');
    }
  };

  // Make the Back button redisplay the previous page.
  window.onpopstate = function (event) {
    if (event.state.content) {
      document.documentElement.innerHTML = event.state.content;
    }
  };
  history.replaceState({ content: document.documentElement.innerHTML }, '');
  // tell the user to wait
  $('body').css('cursor', 'wait');

  // in Firefox, use content.fetch for content-specific fetch requests
  // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#XHR_and_Fetch
  const browserSpecificFetch =
    navigator.userAgent.indexOf('Safari') + navigator.userAgent.indexOf('Chrome') < 0 ? content.fetch : window.fetch;

  // fetch the html page which contains the <iframe> link to the zip document.
  const htmlPage = await browserSpecificFetch(event.data.id).then((res) => res.text());
  console.log('RECAP: Successfully submitted zip file request');
  const zipUrl = extractUrl(htmlPage);
  //download zip file and save it to chrome storage
  const blob = await fetch(zipUrl).then((res) => res.blob());
  const dataUrl = await blobToDataURL(blob);
  console.info('RECAP: Downloaded zip file');
  // save blob in storage under tabId
  // we store it as an array to chunk the message
  await updateTabStorage({
    [this.tabId]: { ['zip_blob']: dataUrl },
  });

  // create the blob and inject it into the page
  const blobUrl = URL.createObjectURL(blob);
  const pacerCaseId = event.data.id.match(/caseid\=\d*/)[0].replace(/caseid\=/, '');

  // load options
  const options = await getItemsFromStorage('options');
  // generate the filename
  const filename = generateFileName(options, pacerCaseId);

  if (options['recap_enabled'] && !this.restricted) {
    this.recap.uploadZipFile(
      this.court, // string
      pacerCaseId, // string
      (ok) => {
        // callback
        if (ok) {
          // show notifier
          this.notifier.showUpload('Zip uploaded to the public RECAP Archive', () => {});
          // convert htmlPage to document
          const link = `<a id="recap-download" href=${blobUrl} download=${filename} width="0" height="0"/>`;
          const htmlBody = stringToDocBody(htmlPage);
          const frame = htmlBody.querySelector('iframe');
          frame.insertAdjacentHTML('beforebegin', link);
          frame.src = '';
          frame.onload = () => document.getElementById('recap-download').click();
          document.body = htmlBody;
          history.pushState({ content: document.body.innerHTML }, '');
        }
      }
    );
  }
};

// Same as handleSingleDocumentPageView, but for zip files
ContentDelegate.prototype.handleZipFilePageView = function () {
  // return if not the download all page
  if (!PACER.isDownloadAllDocumentsPage(this.url, document)) {
    return;
  }

  // return if on the appellate courts
  if (PACER.isAppellateCourt(this.court)) {
    debug(4, 'No interposition for appellate downloads yet');
    return;
  }

  // extract the url from the onclick attribute from one of the two
  // "Download Documents" buttons
  const inputs = [...document.getElementsByTagName('input')];
  const targetInputs = inputs.filter((input) => input.type === 'button' && input.value === 'Download Documents');
  const url = targetInputs[0]
    .getAttribute('onclick')
    .replace(/p.*\//, '') // remove parent.location='/cgi-bin/
    .replace(/\'(?=$)/, ''); // remove endquote

  const isAppendixPage = url.match(/create\_appendix\=1/);
  if (isAppendixPage) {
    debug(4, 'No interposition for appendix page downloads yet');
    return;
  }

  // imperatively manipulate hte dom elements without injecting a script
  const forms = [...document.querySelectorAll('form')];
  forms.map((form) => {
    form.removeAttribute('action');
    const input = form.querySelector('input');
    input.removeAttribute('onclick');
    input.disabled = true;
    form.hidden = true;
    const div = document.createElement('div');
    const button = document.createElement('button');
    button.textContent = 'Download Documents';
    button.addEventListener('click', () => window.postMessage({ id: url }));
    div.appendChild(button);
    const parentNode = form.parentNode;
    parentNode.insertBefore(div, form);
  });
  // When we receive the message from the above submit method, submit the form
  // via fetch so we can get the document before the browser does.
  window.addEventListener('message', this.onDownloadAllSubmit.bind(this));
};

ContentDelegate.prototype.handleClaimsPageView = function () {
  // return if not a claims register page
  if (!PACER.isClaimsRegisterPage(this.url, document)) {
    return;
  }

  const pacerCaseId = this.pacer_case_id ? this.pacer_case_id : PACER.getCaseIdFromClaimsPage(document);

  // render the page as a string and upload it to recap
  const claimsPageHtml = document.documentElement.outerHTML;
  this.recap.uploadClaimsRegister(this.court, pacerCaseId, claimsPageHtml, (ok) => {
    // callback - dispatch the notifier if upload is ok
    if (ok) {
      this.notifier.showUpload('Claims page uploaded to the public RECAP Archive', () => {});
    } else {
      console.error('Page not uploaded to the public RECAP archive.');
    }
  });
};
