import { Op } from 'sequelize'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../server/config/config.js'
import { logger } from '../server/config/logs.js'
import {
  checkForApplications,
  checkForEligibleApplications,
  placeBackInTheQueue,
  updateApplicationAsProcessing,
} from '../server/controllers/pollForApplicationsController.js'
import { Application, ExportedApplicationData, sequelize } from '../server/models/index.js'

let loggerErrorStub

describe('pollForApplications behavior', () => {
  beforeEach(() => {
    loggerErrorStub = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('checkForEligibleApplications', () => {
    it('uses queued status and max retry threshold from config', async () => {
      const findOneStub = vi.spyOn(Application, 'findOne').mockResolvedValue(null)

      await checkForEligibleApplications()

      expect(findOneStub).toHaveBeenCalledOnce()
      expect(findOneStub).toHaveBeenCalledWith({
        where: {
          submitted: 'queued',
          submissionAttempts: {
            [Op.lt]: parseInt(config.maxRetryAttempts, 10),
          },
        },
        order: sequelize.random(),
      })
    })
  })

  describe('checkForApplications', () => {
    it('does nothing further when no eligible application exists', async () => {
      const findOneStub = vi.spyOn(Application, 'findOne').mockResolvedValue(null)
      const updateStub = vi.spyOn(Application, 'update').mockResolvedValue(undefined)

      await checkForApplications()

      expect(findOneStub).toHaveBeenCalledOnce()
      expect(updateStub).not.toHaveBeenCalled()
    })

    it('marks an application as failed when exported app data is missing', async () => {
      vi.spyOn(Application, 'findOne').mockResolvedValue({
        application_id: 1001,
        submissionAttempts: 1,
        serviceType: 1,
      })
      const updateStub = vi.spyOn(Application, 'update').mockResolvedValue([1])
      vi.spyOn(ExportedApplicationData, 'findOne').mockResolvedValue(null)

      await checkForApplications()

      expect(updateStub.mock.calls[0]).toEqual([{ submitted: 'processing' }, { where: { application_id: 1001 } }])
      expect(updateStub.mock.calls[1]).toEqual([{ submitted: 'failed' }, { where: { application_id: 1001 } }])
    })
  })

  describe('error handling', () => {
    it('updateApplicationAsProcessing logs and returns undefined on update error', async () => {
      vi.spyOn(Application, 'update').mockRejectedValue(new Error('db down'))

      const result = await updateApplicationAsProcessing(123, true)

      expect(result).toBeUndefined()
      expect(loggerErrorStub).toHaveBeenCalledOnce()
      expect(loggerErrorStub).toHaveBeenCalledWith('Error in updateApplicationAsProcessing for 123', {
        application_id: 123,
        error: new Error('db down'),
      })
    })

    it('placeBackInTheQueue logs and returns undefined on update error', async () => {
      vi.spyOn(Application, 'update').mockRejectedValue(new Error('db down'))

      const result = await placeBackInTheQueue(123, 2)

      expect(result).toBeUndefined()
      expect(loggerErrorStub).toHaveBeenCalledOnce()
      expect(loggerErrorStub).toHaveBeenCalledWith('Error in placeBackInTheQueue for 123', {
        application_id: 123,
        error: new Error('db down'),
      })
    })
  })
})
