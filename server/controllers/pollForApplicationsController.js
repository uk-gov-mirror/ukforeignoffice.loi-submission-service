import { GetObjectCommand, S3 } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import axios from 'axios'
import { Op } from 'sequelize'
import { config } from '../config/config.js'
import { logger } from '../config/logs.js'
import {
  Application,
  ExportedApplicationData,
  ExportedEAppData,
  SubmissionAttempts,
  sequelize,
  UploadedDocumentUrls,
} from '../models/index.js'
import { HelperService } from '../services/HelperService.js'

const isNumeric = (value) => !Number.isNaN(parseFloat(value)) && Number.isFinite(value)
const maxRetryAttempts = parseInt(config.maxRetryAttempts, 10)
const s3 = new S3()

export async function checkForApplications() {
  try {
    const results = await checkForEligibleApplications()
    if (results) {
      const { application_id, submissionAttempts, serviceType } = results
      await processApplication(application_id, submissionAttempts, serviceType)
    }
  } catch (error) {
    logger.error(`Error in checkForApplications: ${error}`)
  }
}

export async function checkForEligibleApplications() {
  try {
    return await Application.findOne({
      where: {
        submitted: 'queued',
        submissionAttempts: {
          [Op.lt]: maxRetryAttempts,
        },
      },
      order: sequelize.random(),
    })
  } catch (error) {
    logger.error('Error in checkForEligibleApplications', {
      error,
    })
  }
}

async function processApplication(application_id, submission_attempts, service_type) {
  try {
    const isEApp = service_type === 4
    await updateApplicationAsProcessing(application_id, isEApp)
    if (isEApp) {
      const eAppData = await getEAppData(application_id)
      if (!eAppData) {
        logger.error(`No exported app data found for ${application_id}`, { additionalPayment: application_id })
        await updateApplicationAsFailed(application_id)
      } else {
        if (config.nodeEnv.toLowerCase() !== 'development') await generatePresignedUrls(application_id)
        const eAppDocuments = await getEAppDocumentUrls(application_id)
        const applicationJsonObject = await generateEAppObject(eAppData, eAppDocuments)
        await postToOrbit(applicationJsonObject, application_id, submission_attempts)
      }
    } else if (!isEApp) {
      const appData = await getAppData(application_id)
      if (!appData) {
        logger.error(`No exported app data found for ${application_id}`, { additionalPayment: application_id })
        await updateApplicationAsFailed(application_id)
      } else {
        const applicationJsonObject = await generateApplicationObject(appData)
        await postToOrbit(applicationJsonObject, application_id, submission_attempts)
      }
    }
  } catch (error) {
    logger.error(`Error in processApplication for ${application_id}`, { additionalPayment: application_id, error })
  }
}

async function getEAppData(application_id) {
  try {
    return await ExportedEAppData.findOne({
      where: {
        application_id: application_id,
      },
    })
  } catch (error) {
    logger.error(`Error in getEAppData for ${application_id}`, { additionalPayment: application_id, error })
  }
}

async function getAppData(application_id) {
  try {
    return await ExportedApplicationData.findOne({
      where: {
        application_id: application_id,
      },
    })
  } catch (error) {
    logger.error(`Error in getAppData for ${application_id}`, { additionalPayment: application_id, error })
  }
}

async function getEAppDocumentUrls(application_id) {
  try {
    return await UploadedDocumentUrls.findAll({
      where: {
        application_id: application_id,
      },
    })
  } catch (error) {
    logger.error(`Error in getEAppDocumentUrls for ${application_id}`, { additionalPayment: application_id, error })
  }
}

async function addPresignedUrlToDB(application_id, url, key) {
  try {
    return await UploadedDocumentUrls.update(
      {
        presigned_url: url,
      },
      {
        where: {
          application_id: application_id,
          uploaded_url: key,
        },
      },
    )
  } catch (error) {
    logger.error(`Error in addPresignedUrlToDB for ${application_id}`, { additionalPayment: application_id, error })
  }
}

async function generatePresignedUrls(application_id) {
  try {
    const S3_BUCKET = config.s3Bucket
    const EXPIRY_SECONDS = 3600

    const documents = await getEAppDocumentUrls(application_id)

    if (!documents || documents.length === 0) {
      logger.error(`No documents found for application ${application_id}`, { additionalPayment: application_id })
      return
    }

    const generateUrlPromises = documents.map(async (doc) => {
      const params = {
        Bucket: S3_BUCKET,
        Key: doc.uploaded_url,
      }

      try {
        const url = await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: EXPIRY_SECONDS })
        logger.info(`Presigned URL generated for ${application_id} ${doc.filename}`, {
          additionalPayment: application_id,
        })
        await addPresignedUrlToDB(application_id, url, doc.uploaded_url)
      } catch (err) {
        logger.error(`Failed to generate presigned URL for ${application_id} ${doc.filename}: ${err}`, {
          additionalPayment: application_id,
          error: err,
        })
        throw new Error(err)
      }
    })

    await Promise.all(generateUrlPromises)
  } catch (error) {
    logger.error(`Error in generatePresignedUrls for ${application_id}`, { additionalPayment: application_id, error })
  }
}

export async function updateApplicationAsProcessing(application_id, isEApp) {
  logger.info(`Processing ${application_id}${isEApp ? ' (eApp)' : ' (paper)'}`, {
    application_id,
    isEApp,
  })
  try {
    return await Application.update(
      {
        submitted: 'processing',
      },
      {
        where: {
          application_id: application_id,
        },
      },
    )
  } catch (error) {
    logger.error(`Error in updateApplicationAsProcessing for ${application_id}`, {
      application_id,
      error,
    })
  }
}

async function updateApplicationAsFailed(application_id) {
  logger.info(`Marking ${application_id} as failed`, { additionalPayment: application_id })
  try {
    return await Application.update(
      {
        submitted: 'failed',
      },
      {
        where: {
          application_id: application_id,
        },
      },
    )
  } catch (error) {
    logger.error(`Error in updateApplicationAsFailed for ${application_id}`, {
      additionalPayment: application_id,
      error,
    })
  }
}

export async function placeBackInTheQueue(application_id, submission_attempts) {
  logger.info(`Updating ${application_id} submission attempts (${submission_attempts}/${maxRetryAttempts})`, {
    application_id,
    submission_attempts,
    maxRetryAttempts,
  })
  try {
    return await Application.update(
      {
        submissionAttempts: submission_attempts,
        submitted: 'queued',
      },
      {
        where: {
          application_id: application_id,
        },
      },
    )
  } catch (error) {
    logger.error(`Error in placeBackInTheQueue for ${application_id}`, { application_id, error })
  }
}

async function updateApplicationAsSubmitted(application_id, response, submission_attempts) {
  logger.info(`Marking ${application_id} as submitted`, { additionalPayment: application_id })
  try {
    return await Application.update(
      {
        submitted: 'submitted',
        application_reference: response.data.contactId ? response.data.contactId : response.data.applicationReference,
        case_reference: response.data.caseId ? response.data.caseId : response.data.caseReference,
        submissionAttempts: submission_attempts,
      },
      {
        where: {
          application_id: application_id,
        },
      },
    )
  } catch (error) {
    logger.error(`Error in updateApplicationAsSubmitted for ${application_id}`, {
      additionalPayment: application_id,
      error,
    })
  }
}

async function generateEAppObject(eAppData, eAppDocumentUrls) {
  try {
    return {
      legalisationApplication: {
        userId: 'legalisation',
        caseType: 'eApostille Service',
        timestamp: Date.now().toString(),
        applicant: {
          forenames: eAppData.first_name?.trim(),
          surname: eAppData.last_name?.trim(),
          primaryTelephone: eAppData.telephone?.trim(),
          mobileTelephone: eAppData.mobileNo?.trim() || eAppData.telephone?.trim(),
          eveningTelephone: '',
          email: eAppData.email,
        },
        fields: {
          applicationReference: eAppData.unique_app_id,
          documentCount: eAppData.doc_count,
          paymentReference: eAppData.payment_reference,
          paymentGateway: 'GOV_PAY',
          paymentAmount: eAppData.payment_amount,
          customerInternalReference: eAppData.user_ref?.trim(),
          feedbackConsent: eAppData.feedback_consent,
          companyName: eAppData.company_name,
          companyRegistrationNumber: '',
          portalCustomerId: eAppData.user_id,
          additionalInformation: '',
        },
        documents: await generateDocumentArray(eAppDocumentUrls),
      },
    }
  } catch (error) {
    logger.error(`Error in generateEAppObject for ${eAppData.unique_app_id}`, {
      additionalPayment: eAppData.unique_app_id,
      error,
    })
  }
}

function generateDocumentArray(eAppDocumentUrls) {
  try {
    return eAppDocumentUrls.map((document) => ({
      name: document.filename,
      downloadUrl: document.presigned_url || document.uploaded_url,
    }))
  } catch (error) {
    logger.error(`Error in generateDocumentArray`, { additionalPayment: null, error })
  }
}

async function postToOrbit(applicationJsonObject, submission_attempts) {
  const controller = new AbortController()
  const signal = controller.signal

  const edmsSubmissionApiUrl = `${config.edmsHost}/api/v1/submitApplication`
  const edmsBearerToken = await HelperService.getEdmsAccessToken()
  const this_submission_attempt = submission_attempts + 1

  try {
    if (!edmsBearerToken) throw new Error('Error fetching access token')

    const profiler = logger.startTimer('Submitting application to ORBIT')
    const response = await axios.post(edmsSubmissionApiUrl, applicationJsonObject, {
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${edmsBearerToken}`,
      },
      timeout: 9000,
      signal,
    })

    profiler.done({
      message: `Orbit application capture request response time for ${applicationJsonObject.application_id}:`,
      applicationJsonObject,
      additionalPayment: applicationJsonObject.application_id,
      ...logger.defaultMeta,
    })

    if (response && response.status === 200) {
      await updateApplicationAsSubmitted(application_id, response, this_submission_attempt)
      await logSubmissionAttempt(
        application_id,
        this_submission_attempt,
        applicationJsonObject,
        'submitted',
        response.status,
        response.data,
      )
    } else {
      controller.abort()
      await placeBackInTheQueue(application_id, this_submission_attempt)
      await logSubmissionAttempt(
        application_id,
        this_submission_attempt,
        applicationJsonObject,
        'failed',
        response.status,
        response.data,
      )
      if (submission_attempts === maxRetryAttempts) {
        await updateApplicationAsFailed(application_id)
      }
    }
  } catch (error) {
    controller.abort()
    logger.error(`Error in postToOrbit: `, { error, applicationJsonObject })
    await placeBackInTheQueue(application_id, this_submission_attempt)
    await logSubmissionAttempt(application_id, this_submission_attempt, applicationJsonObject, 'failed', null, null)
    if (this_submission_attempt === maxRetryAttempts) {
      await updateApplicationAsFailed(application_id)
    }
  }
}

function logSubmissionAttempt(
  application_id,
  retry_number,
  submitted_json,
  status,
  response_status_code,
  response_body,
) {
  try {
    return SubmissionAttempts.create({
      application_id: application_id,
      retry_number: retry_number || 0,
      submitted_json: submitted_json,
      status: status,
      response_status_code: response_status_code,
      response_body: JSON.stringify(response_body),
    })
  } catch (error) {
    logger.error(`Error in logSubmissionAttempt: ${error}`, { application_id, submitted_json, error })
  }
}

function trimWhitespace(input) {
  if (typeof input === 'string') {
    return input.trim()
  }
  if (input === null || input === undefined) {
    return ''
  }
  return input
}

function generateApplicationObject(results) {
  let altFullName
  let altStreet
  let altTown
  let altCounty
  let altCountry
  let altPostcode
  let altTelephone
  let altMobileNo
  let altEmail

  const submissionJSON = {
    main: {
      companyName:
        results.main_organisation !== 'N/A' && results.main_organisation !== null && results.main_organisation !== ' '
          ? results.main_organisation
          : '',
      flatNumber: '',
      premises: '',
      houseNumber: '',
      postcode: results.postcode,
    },
    alt: {
      companyName: '',
      flatNumber: '',
      premises: '',
      houseNumber: '',
      postcode: '',
    },
  }

  updateSubmissionJSON('main', trimWhitespace(results.main_house_name))

  // if there is no alternate address, copy the details from the main address
  if (results.alt_full_name) {
    altFullName = results.alt_full_name
    altStreet = results.alt_street
    altTown = results.alt_town
    altCounty = results.alt_county
    altCountry = results.alt_country
    altPostcode = results.alt_postcode
    altTelephone = results.alt_telephone
    altMobileNo = results.alt_mobileNo
    altEmail = results.alt_email
    submissionJSON.postcode = results.alt_postcode
    submissionJSON.alt.companyName =
      results.alt_organisation &&
      results.alt_organisation !== 'N/A' &&
      results.alt_organisation.length !== 0 &&
      results.alt_organisation !== ' '
        ? results.alt_organisation
        : ''
    updateSubmissionJSON('alt', trimWhitespace(results.alt_house_name))
  } else {
    altFullName = results.main_full_name
    submissionJSON.alt.companyName = submissionJSON.main.companyName
    updateSubmissionJSON('alt', trimWhitespace(results.main_house_name))
    altStreet = results.main_street
    altTown = results.main_town
    altCounty = results.main_county
    altCountry = results.main_country
    altPostcode = results.main_postcode
    altTelephone = results.main_telephone
    altMobileNo = results.main_mobileNo
    altEmail = results.main_email
  }

  function updateSubmissionJSON(type, house) {
    const house_name = house.toString().split(' ')
    const apartments = house.indexOf('Apartments')
    const flats = house.indexOf('Flat')

    if (
      house_name[0] &&
      house_name[1] &&
      house_name[0].toLowerCase() === 'flat' &&
      isNumeric(house_name[1].replace(',', '').substr(1, isNumeric(house_name[1].replace(',', '').length)))
    ) {
      submissionJSON[type].flatNumber = house_name[1].replace(',', '')

      if (isNumeric(house_name[house_name.length - 1].replace('-', '').replace(',', ''))) {
        submissionJSON[type].houseNumber = house_name[house_name.length - 1].replace(',', '')
        submissionJSON[type].premises = house.substr(
          submissionJSON[type].flatNumber.length + 7,
          house.toString().length -
            (submissionJSON[type].flatNumber.length + 7) -
            (submissionJSON[type].houseNumber.length + 1),
        )
      } else {
        submissionJSON[type].premises = house
          .substr(house_name[0].length + house_name[1].length + 1, house.length)
          .replace(',', '')
      }
    } else if (isNumeric(house_name[house_name.length - 1].replace('-', ''))) {
      submissionJSON[type].houseNumber = house_name[house_name.length - 1]
      if (apartments !== -1 || flats !== -1) {
        const subBuilding = house.substr(0, house.length - house_name[house_name.length - 1].length).replace(',', '')
        if (subBuilding.split(' ')[0].toLowerCase() === 'flat') {
          submissionJSON[type].flatNumber = subBuilding.split(' ')[1]
          submissionJSON[type].premises = subBuilding
            .substr(subBuilding.split(' ')[0].length + subBuilding.split(' ')[1].length + 2, subBuilding.length - 1)
            .replace(',', '')
        } else {
          submissionJSON[type].flatNumber = subBuilding.split(' ')[0]
          submissionJSON[type].premises = subBuilding
            .substr(subBuilding.split(' ')[0].length, subBuilding.length - 1)
            .replace(',', '')
        }
      } else {
        submissionJSON[type].premises = house
          .substr(0, house.length - house_name[house_name.length - 1].length)
          .replace(',', '')
      }
    } else if (
      house_name[0] &&
      house_name[1] &&
      house_name[0].toLowerCase() === 'flat' &&
      isNumeric(house_name[1].replace(',', ''))
    ) {
      submissionJSON[type].flatNumber = house_name[1].replace(',', '')
      submissionJSON[type].premises = house
        .substr(house_name[0].length + house_name[1].length + 1, house.length)
        .replace(',', '')
    } else if (isNumeric(house_name[0].split(/[A-Za-z]/)[0])) {
      submissionJSON[type].houseNumber = house_name[0]
      submissionJSON[type].premises = house.substr(house_name[0].length + 1, house.length).replace(',', '')
    } else if (isNumeric(house_name[0].replace('-', ''))) {
      submissionJSON[type].houseNumber = house_name[0].replace(',', '')
      submissionJSON[type].premises = house.substr(house_name[0].length + 1, house.length).replace(',', '')
    } else if (isNumeric(house_name[0].replace(',', ''))) {
      submissionJSON[type].houseNumber = house_name[0].replace(',', '')
      submissionJSON[type].premises = house
        .substr(house_name[0].length + 1, house.length - house_name[0].length + 1)
        .replace(',', '')
    } else if (house.length > 10) {
      submissionJSON[type].premises = house.replace(',', '')
    } else {
      submissionJSON[type].premises = house
    }

    // Catch all fixes
    if (submissionJSON[type].houseNumber.length > 10) {
      submissionJSON[type].premises = submissionJSON[type].houseNumber + submissionJSON[type].premises
      submissionJSON[type].houseNumber = ''
    }
    if (submissionJSON[type].flatNumber.length > 10) {
      submissionJSON[type].premises = `Flat ${submissionJSON[type].flatNumber}${submissionJSON[type].premises}`
      submissionJSON[type].flatNumber = ''
    }
  }

  let obj

  if (results.applicationType === 'Postal Service') {
    obj = {
      legalisationApplication: {
        userId: 'legalisation',
        caseType: results.applicationType,
        timestamp: Date.now().toString(),
        applicant: {
          forenames: trimWhitespace(results.first_name),
          surname: trimWhitespace(results.last_name),
          primaryTelephone: trimWhitespace(results.telephone),
          mobileTelephone: trimWhitespace(results.mobileNo) || trimWhitespace(results.telephone),
          eveningTelephone: '',
          email: trimWhitespace(results.email),
        },
        fields: {
          applicationReference: results.unique_app_id,
          postalType: results.postage_return_title,
          documentCount: results.doc_count,
          paymentReference: results.payment_reference,
          paymentAmount: results.payment_amount,
          paymentGateway: 'GOV_PAY',
          customerInternalReference: trimWhitespace(results.user_ref),
          feedbackConsent: trimWhitespace(results.feedback_consent),
          companyName: results.company_name !== 'N/A' ? results.company_name : '',
          companyRegistrationNumber: '',
          portalCustomerId: results.user_id === 0 ? '' : results.user_id,
          successfulReturnDetails: {
            fullName: trimWhitespace(results.main_full_name),
            address: {
              companyName: submissionJSON.main.companyName,
              flatNumber: submissionJSON.main.flatNumber || '',
              premises: submissionJSON.main.premises || '',
              houseNumber: submissionJSON.main.houseNumber || '',
              street: trimWhitespace(results.main_street),
              district: '',
              town: trimWhitespace(results.main_town) || '',
              region: trimWhitespace(results.main_county) || '',
              postcode: trimWhitespace(results.main_postcode),
              country: trimWhitespace(results.main_country || 'United Kingdom'),
            },
            telephone: trimWhitespace(results.main_telephone || ''),
            mobileNo: trimWhitespace(results.main_mobileNo || results.main_telephone),
            email: trimWhitespace(results.main_email || ''),
          },
          unsuccessfulReturnDetails: {
            fullName: altFullName,
            address: {
              companyName: submissionJSON.alt.companyName,
              flatNumber: submissionJSON.alt.flatNumber || '',
              premises: submissionJSON.alt.premises || '',
              houseNumber: submissionJSON.alt.houseNumber || '',
              street: trimWhitespace(altStreet) || '',
              district: '',
              town: trimWhitespace(altTown) || '',
              region: trimWhitespace(altCounty),
              postcode: trimWhitespace(altPostcode),
              country: trimWhitespace(altCountry || 'United Kingdom'),
            },
            telephone: trimWhitespace(altTelephone || ''),
            mobileNo: trimWhitespace(altMobileNo || altTelephone),
            email: trimWhitespace(altEmail || ''),
          },
          additionalInformation: '',
        },
      },
    }
  } else {
    obj = {
      legalisationApplication: {
        userId: 'legalisation',
        caseType: results.applicationType,
        timestamp: Date.now().toString(),
        applicant: {
          forenames: trimWhitespace(results.first_name),
          surname: trimWhitespace(results.last_name),
          primaryTelephone: trimWhitespace(results.telephone),
          mobileTelephone: trimWhitespace(results.mobileNo) || trimWhitespace(results.telephone),
          eveningTelephone: '',
          email: trimWhitespace(results.email),
        },
        fields: {
          applicationReference: results.unique_app_id,
          postalType: results.postage_return_title,
          documentCount: results.doc_count,
          paymentReference: results.payment_reference,
          paymentAmount: results.payment_amount,
          paymentGateway: 'GOV_PAY',
          customerInternalReference: trimWhitespace(results.user_ref),
          feedbackConsent: trimWhitespace(results.feedback_consent),
          companyName: results.company_name !== 'N/A' ? results.company_name : '',
          companyRegistrationNumber: '',
          portalCustomerId: results.user_id === 0 ? '' : results.user_id,
          additionalInformation: '',
        },
      },
    }
  }

  return obj
}
